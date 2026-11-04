import { createDatabase, migrate } from "./database.js";
import { createApp } from "./app.js";
import { createCollaboration } from "./collaboration.js";
import { digest } from "./security.js";

const db = await createDatabase();
await migrate(db);
const collaboration = createCollaboration(
  db,
  process.env.APP_ORIGIN || "http://127.0.0.1:5173",
);
const { app, userFor, automations } = await createApp(db, {
  onAccessChange: collaboration.revalidateConnections,
});
app.post("/api/collaboration/ticket", async (req) => {
  const user = await userFor(req);
  return {
    ticket: collaboration.issue(user.id, digest(req.cookies.kelvin_session!)),
  };
});
await collaboration.server.listen();
await app.listen({
  host: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT || 4310),
});
console.info("Dayline API is ready.");
automations.start();
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    await collaboration.server.destroy();
    await app.close();
    await db.close();
    process.exit(0);
  });
