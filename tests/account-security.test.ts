import { test } from "node:test";
import assert from "node:assert/strict";
import { createDatabase, migrate } from "../server/database";
import { createApp } from "../server/app";
import { totp } from "../server/account-security";

test("MFA, single-use recovery, invitation proof and password/session lifecycle", async () => {
  const db = await createDatabase(undefined, "memory://");
  await migrate(db);
  const { app } = await createApp(db, {
    origin: "http://security.test",
    encryptionKey: "cd".repeat(32),
  });
  let cookie = "";
  const headers = { "x-kelvin-client": "web", "X-Kelvin-Document-Schema": "1", origin: "http://security.test" };
  const request = (method: any, url: string, payload?: any, session = cookie) =>
    app.inject({
      method,
      url,
      payload,
      headers: { ...headers, ...(session ? { cookie: session } : {}) },
    });
  const adopt = (response: any) => {
    assert.equal(response.statusCode, 200, response.body);
    cookie = response.headers["set-cookie"].toString().split(";")[0];
  };
  try {
    adopt(
      await request(
        "POST",
        "/api/setup",
        {
          name: "Security fixture",
          email: "security@example.test",
          password: "initial-fixture-password",
          workspaceName: "Security fixtures",
        },
        "",
      ),
    );
    const setup = await request("POST", "/api/account/mfa/setup", {
      password: "initial-fixture-password",
    });
    assert.equal(setup.statusCode, 200, setup.body);
    const { secret, qr } = setup.json();
    assert.ok(secret.length >= 32);
    assert.ok(qr.startsWith("data:image/png"));
    const activationCode = totp(secret, "security@example.test").generate();
    const enabled = await request("POST", "/api/account/mfa/enable", {
      otp: activationCode,
    });
    assert.equal(enabled.statusCode, 200, enabled.body);
    const codes = enabled.json().recoveryCodes;
    assert.equal(codes.length, 10);
    const status = await request("GET", "/api/account/security");
    assert.equal(status.json().mfaEnabled, true);
    assert.ok(!status.body.includes(secret));
    const passwordOnly = await request(
      "POST",
      "/api/login",
      { email: "security@example.test", password: "initial-fixture-password" },
      "",
    );
    assert.equal(passwordOnly.statusCode, 401);
    assert.equal(passwordOnly.json().detail.mfaRequired, true);
    const replay = await request(
      "POST",
      "/api/login",
      {
        email: "security@example.test",
        password: "initial-fixture-password",
        otp: activationCode,
      },
      "",
    );
    assert.equal(replay.statusCode, 401);
    adopt(
      await request(
        "POST",
        "/api/login",
        {
          email: "security@example.test",
          password: "initial-fixture-password",
          recoveryCode: codes[0],
        },
        "",
      ),
    );
    const oldCookie = cookie;
    assert.equal(
      (
        await request(
          "POST",
          "/api/login",
          {
            email: "security@example.test",
            password: "initial-fixture-password",
            recoveryCode: codes[0],
          },
          "",
        )
      ).statusCode,
      401,
    );
    adopt(
      await request("POST", "/api/account/password", {
        password: "initial-fixture-password",
        recoveryCode: codes[1],
        newPassword: "changed-fixture-password",
      }),
    );
    assert.equal(
      (await request("GET", "/api/me", undefined, oldCookie)).statusCode,
      401,
    );
    assert.equal(
      (
        await request(
          "POST",
          "/api/account/recover",
          {
            email: "security@example.test",
            recoveryCode: codes[2],
            newPassword: "recovered-fixture-password",
          },
          "",
        )
      ).statusCode,
      200,
    );
    assert.equal((await request("GET", "/api/me")).statusCode, 401);
    adopt(
      await request(
        "POST",
        "/api/login",
        {
          email: "security@example.test",
          password: "recovered-fixture-password",
          recoveryCode: codes[3],
        },
        "",
      ),
    );
    const profile = (await request("GET", "/api/me")).json();
    const workspace = profile.workspaces[0].id;
    const invited = await request(
      "POST",
      `/api/workspaces/${workspace}/invitations`,
      { email: "security@example.test", role: "member" },
    );
    const token = new URL(invited.json().url).searchParams.get("invitation");
    const bypass = await request(
      "POST",
      "/api/invitations/accept",
      {
        email: "security@example.test",
        password: "recovered-fixture-password",
        name: "Security fixture",
        token,
      },
      "",
    );
    assert.equal(bypass.statusCode, 401);
    assert.equal(bypass.json().detail.mfaRequired, true);
    assert.equal(
      (
        await request("POST", "/api/account/mfa/disable", {
          password: "recovered-fixture-password",
          recoveryCode: codes[4],
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await request("GET", "/api/account/security")).json().mfaEnabled,
      false,
    );
    const stored = (
      await db.query(
        "SELECT mfa_secret,recovery_hashes FROM app_users WHERE email=$1",
        ["security@example.test"],
      )
    ).rows[0];
    assert.equal(stored.mfa_secret, null);
    assert.ok(!JSON.stringify(stored.recovery_hashes).includes(codes[5]));
  } finally {
    await app.close();
    await db.close();
  }
});
test("passwords need at least eight characters", async () => {
  const db = await createDatabase(undefined, "memory://");
  await migrate(db);
  const { app } = await createApp(db, {
    origin: "http://security.test",
    encryptionKey: "cd".repeat(32),
  });
  const headers = { "x-kelvin-client": "web", "X-Kelvin-Document-Schema": "1", origin: "http://security.test" };
  try {
    const setup = (password: string) =>
      app.inject({
        method: "POST",
        url: "/api/setup",
        headers,
        payload: { name: "Length fixture", email: "length@example.test", password, workspaceName: "Length" },
      });
    assert.equal((await setup("Short71")).statusCode, 400);
    const accepted = await setup("MiClave8");
    assert.equal(accepted.statusCode, 200, accepted.body);
    const cookie = accepted.headers["set-cookie"]!.toString().split(";")[0];
    const change = (newPassword: string) =>
      app.inject({
        method: "POST",
        url: "/api/account/password",
        headers: { ...headers, cookie },
        payload: { password: "MiClave8", newPassword },
      });
    assert.equal((await change("Seven77")).statusCode, 400);
    assert.equal((await change("Eight888")).statusCode, 200);
  } finally {
    await app.close();
    await db.close();
  }
});
