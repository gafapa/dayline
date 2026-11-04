import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { randomBytes } from "node:crypto";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import { z } from "zod";
import {
  decrypt,
  encrypt,
  hashPassword,
  verifyPassword,
  digest,
} from "./security.js";
import { HttpError } from "./errors.js";
import type { Connection, Database } from "./database.js";
import type { User } from "../shared/model.js";

export function totp(secret: string, email: string) {
  return new OTPAuth.TOTP({
    issuer: "Dayline",
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret),
  });
}
const proofSchema = z.object({
  password: z.string().min(1).max(200),
  otp: z.string().max(20).optional(),
  recoveryCode: z.string().max(100).optional(),
});
const codeHash = (value: string) =>
  digest(value.trim().toUpperCase().replace(/[-\s]/g, ""));
function newRecoveryCodes() {
  return Array.from({ length: 10 }, () =>
    randomBytes(16)
      .toString("hex")
      .toUpperCase()
      .match(/.{1,8}/g)!
      .join("-"),
  );
}

export async function verifySecondFactor(
  tx: Connection,
  account: any,
  input: { otp?: string; recoveryCode?: string },
  key?: string,
) {
  if (!account.mfa_secret) return;
  if (input.recoveryCode) {
    const hash = codeHash(input.recoveryCode);
    const codes: string[] = account.recovery_hashes || [];
    if (!codes.includes(hash))
      throw new HttpError(401, "El código de recuperación no es válido.");
    await tx.query("UPDATE app_users SET recovery_hashes=$1 WHERE id=$2", [
      JSON.stringify(codes.filter((c) => c !== hash)),
      account.id,
    ]);
    return;
  }
  if (!key || !input.otp)
    throw new HttpError(
      401,
      "Introduce el código de tu aplicación de autenticación.",
      { mfaRequired: true },
    );
  const timestamp = Date.now();
  const delta = totp(decrypt(account.mfa_secret, key), account.email).validate({
    token: input.otp,
    window: 1,
    timestamp,
  });
  const counter = delta === null ? 0 : Math.floor(timestamp / 30000) + delta;
  if (delta === null || counter <= Number(account.mfa_last_counter || 0))
    throw new HttpError(401, "El código no es válido o ya se ha utilizado.", {
      mfaRequired: true,
    });
  await tx.query("UPDATE app_users SET mfa_last_counter=$1 WHERE id=$2", [
    counter,
    account.id,
  ]);
}

export function registerAccountSecurity(
  app: FastifyInstance,
  db: Database,
  options: {
    key?: string;
    userFor: (req: FastifyRequest) => Promise<User>;
    session: (
      userId: string,
      reply: FastifyReply,
      req: FastifyRequest,
    ) => Promise<void>;
  },
) {
  async function accountWithProof(
    tx: Connection,
    user: User,
    input: z.infer<typeof proofSchema>,
  ) {
    const account = (
      await tx.query("SELECT * FROM app_users WHERE id=$1 FOR UPDATE", [
        user.id,
      ])
    ).rows[0];
    if (!(await verifyPassword(input.password, account.password_hash)))
      throw new HttpError(401, "La contraseña actual no es correcta.");
    await verifySecondFactor(tx, account, input, options.key);
    return account;
  }
  app.get("/api/account/security", async (req) => {
    const user = await options.userFor(req);
    const account = (
      await db.query(
        "SELECT mfa_secret,recovery_hashes FROM app_users WHERE id=$1",
        [user.id],
      )
    ).rows[0];
    return {
      mfaEnabled: !!account.mfa_secret,
      recoveryCodesRemaining: (account.recovery_hashes || []).length,
      encryptionAvailable: !!options.key,
    };
  });
  app.post(
    "/api/account/password",
    { config: { rateLimit: { max: 8, timeWindow: "15 minutes" } } },
    async (req, reply) => {
      const user = await options.userFor(req);
      const input = proofSchema
        .extend({ newPassword: z.string().min(8).max(200) })
        .parse(req.body);
      const hash = await hashPassword(input.newPassword);
      const id = await db.transaction(async (tx) => {
        const account = await accountWithProof(tx, user, input);
        await tx.query("UPDATE app_users SET password_hash=$1 WHERE id=$2", [
          hash,
          account.id,
        ]);
        await tx.query("DELETE FROM sessions WHERE user_id=$1", [account.id]);
        return account.id;
      });
      await options.session(id, reply, req);
      return { ok: true, otherSessionsRevoked: true };
    },
  );
  app.post(
    "/api/account/mfa/setup",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (req) => {
      if (!options.key)
        throw new HttpError(
          503,
          "El cifrado del servidor no está configurado.",
        );
      const user = await options.userFor(req);
      const input = proofSchema.parse(req.body);
      const secret = new OTPAuth.Secret({ size: 20 }).base32;
      const account = await db.transaction(async (tx) => {
        const account = await accountWithProof(tx, user, input);
        if (account.mfa_secret)
          throw new HttpError(
            409,
            "La verificación en dos pasos ya está activada.",
          );
        await tx.query(
          "UPDATE app_users SET mfa_pending_secret=$1,mfa_pending_expires_at=now()+interval '10 minutes' WHERE id=$2",
          [encrypt(secret, options.key!), account.id],
        );
        return account;
      });
      const uri = totp(secret, account.email).toString();
      return {
        secret,
        uri,
        qr: await QRCode.toDataURL(uri, { width: 240, margin: 2 }),
        expiresInMinutes: 10,
      };
    },
  );
  app.post(
    "/api/account/mfa/enable",
    { config: { rateLimit: { max: 8, timeWindow: "15 minutes" } } },
    async (req) => {
      const user = await options.userFor(req);
      const input = z
        .object({ otp: z.string().regex(/^\d{6}$/) })
        .parse(req.body);
      const codes = newRecoveryCodes();
      await db.transaction(async (tx) => {
        const account = (
          await tx.query("SELECT * FROM app_users WHERE id=$1 FOR UPDATE", [
            user.id,
          ])
        ).rows[0];
        if (
          !options.key ||
          !account.mfa_pending_secret ||
          new Date(account.mfa_pending_expires_at).getTime() < Date.now()
        )
          throw new HttpError(409, "Vuelve a iniciar la configuración.");
        const timestamp = Date.now();
        const delta = totp(
          decrypt(account.mfa_pending_secret, options.key),
          account.email,
        ).validate({ token: input.otp, window: 1, timestamp });
        if (delta === null) throw new HttpError(401, "El código no es válido.");
        await tx.query(
          "UPDATE app_users SET mfa_secret=mfa_pending_secret,mfa_pending_secret=NULL,mfa_pending_expires_at=NULL,mfa_last_counter=$1,recovery_hashes=$2 WHERE id=$3",
          [
            Math.floor(timestamp / 30000) + delta,
            JSON.stringify(codes.map(codeHash)),
            user.id,
          ],
        );
        await tx.query(
          "DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2",
          [user.id, digest(req.cookies.kelvin_session!)],
        );
      });
      return { ok: true, recoveryCodes: codes };
    },
  );
  app.post(
    "/api/account/mfa/disable",
    { config: { rateLimit: { max: 8, timeWindow: "15 minutes" } } },
    async (req) => {
      const user = await options.userFor(req);
      const input = proofSchema.parse(req.body);
      await db.transaction(async (tx) => {
        const account = await accountWithProof(tx, user, input);
        await tx.query(
          "UPDATE app_users SET mfa_secret=NULL,mfa_pending_secret=NULL,mfa_last_counter=0 WHERE id=$1",
          [account.id],
        );
        await tx.query(
          "DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2",
          [account.id, digest(req.cookies.kelvin_session!)],
        );
      });
      return { ok: true };
    },
  );
  app.post(
    "/api/account/recovery-codes",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (req) => {
      const user = await options.userFor(req);
      const input = proofSchema.parse(req.body);
      const codes = newRecoveryCodes();
      await db.transaction(async (tx) => {
        const account = await accountWithProof(tx, user, input);
        await tx.query("UPDATE app_users SET recovery_hashes=$1 WHERE id=$2", [
          JSON.stringify(codes.map(codeHash)),
          account.id,
        ]);
      });
      return { recoveryCodes: codes };
    },
  );
  app.post(
    "/api/account/recover",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (req, reply) => {
      const input = z
        .object({
          email: z.email().transform((v) => v.toLowerCase()),
          recoveryCode: z.string().min(20).max(100),
          newPassword: z.string().min(8).max(200),
        })
        .parse(req.body);
      const passwordHash = await hashPassword(input.newPassword);
      await db.transaction(async (tx) => {
        const account = (
          await tx.query("SELECT * FROM app_users WHERE email=$1 FOR UPDATE", [
            input.email,
          ])
        ).rows[0];
        const hash = codeHash(input.recoveryCode);
        if (!account || !(account.recovery_hashes || []).includes(hash))
          throw new HttpError(
            401,
            "No se pudo recuperar la cuenta con esos datos.",
          );
        await tx.query(
          "UPDATE app_users SET password_hash=$1,recovery_hashes=$2 WHERE id=$3",
          [
            passwordHash,
            JSON.stringify(
              account.recovery_hashes.filter((c: string) => c !== hash),
            ),
            account.id,
          ],
        );
        await tx.query("DELETE FROM sessions WHERE user_id=$1", [account.id]);
      });
      reply.clearCookie("kelvin_session", { path: "/" });
      return { ok: true, mfaPreserved: true };
    },
  );
}
