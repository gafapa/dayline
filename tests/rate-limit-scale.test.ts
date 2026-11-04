import { test } from "node:test";
import assert from "node:assert/strict";
import { createDatabase, migrate } from "../server/database";
import { createApp } from "../server/app";

const headers = { "x-kelvin-client": "web", origin: "http://scale.test" };
async function loginAttempts(production: boolean) {
  const db = await createDatabase(undefined, "memory://");
  await migrate(db);
  const { app } = await createApp(db, {
    origin: "http://scale.test",
    production,
    setupToken: "scale-setup-token",
    encryptionKey: "ab".repeat(32),
  });
  const codes: number[] = [];
  for (let attempt = 0; attempt < 9; attempt++)
    codes.push(
      (
        await app.inject({
          method: "POST",
          url: "/api/login",
          headers,
          payload: { email: "absent@example.test", password: "scale-password-long" },
        })
      ).statusCode,
    );
  await app.close();
  await db.close();
  return codes;
}

test("TEST_RATE_LIMIT_SCALE raises limits outside production and is ignored in production", async () => {
  const previous = process.env.TEST_RATE_LIMIT_SCALE;
  process.env.TEST_RATE_LIMIT_SCALE = "50";
  try {
    assert.equal((await loginAttempts(false)).at(-1), 401, "scaled: the ninth attempt is still allowed");
    assert.equal((await loginAttempts(true)).at(-1), 429, "production keeps the real limit");
  } finally {
    if (previous === undefined) delete process.env.TEST_RATE_LIMIT_SCALE;
    else process.env.TEST_RATE_LIMIT_SCALE = previous;
  }
});
