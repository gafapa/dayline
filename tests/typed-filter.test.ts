import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTaskQuery, parseTaskQuery } from "../shared/collections";

const members = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Lucía Martín" },
  { id: "22222222-2222-4222-8222-222222222222", name: "Jorge Ruiz" },
];
test("the typed filter maps tokens to view fields and keeps the rest as text", () => {
  const parsed = parseTaskQuery("estado:Hecho @lucia @yo vence:semana #api prioridad:ALTA informe final", members);
  assert.deepEqual(parsed, {
    query: "informe final",
    statuses: ["done"],
    assignees: [members[0].id, "me"],
    due: "week",
    labels: ["api"],
    priorities: ["high"],
  });
});
test("unknown tokens and people stay as free text", () => {
  const parsed = parseTaskQuery("estado:raro @nadie @desconocido hola", members);
  assert.deepEqual(parsed.statuses, []);
  assert.deepEqual(parsed.assignees, ["unassigned"]);
  assert.equal(parsed.query, "estado:raro @desconocido hola");
});
test("formatting a view gives text that parses back to the same fields", () => {
  const fields = parseTaskQuery("estado:en-curso @jorge vence:vencidas #movil prioridad:urgente login", members);
  assert.deepEqual(parseTaskQuery(formatTaskQuery(fields, members), members), fields);
});
