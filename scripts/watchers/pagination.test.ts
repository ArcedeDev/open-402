import test from "node:test";
import assert from "node:assert/strict";

import { getNextOffset, parsePaginatedServicesResponse } from "./pagination.ts";

test("parsePaginatedServicesResponse honors server-returned limit and total", () => {
  const page = parsePaginatedServicesResponse(
    {
      services: [{ id: 1 }, { id: 2 }],
      total: 634,
      limit: 200,
      offset: 400,
    },
    400
  );

  assert.equal(page.items.length, 2);
  assert.equal(page.total, 634);
  assert.equal(page.limit, 200);
  assert.equal(page.offset, 400);
});

test("getNextOffset advances by items returned, not requested page size", () => {
  const page = parsePaginatedServicesResponse(
    {
      services: new Array(200).fill({ protocol: "L402" }),
      total: 634,
      limit: 200,
      offset: 0,
    },
    0
  );

  assert.equal(getNextOffset(page), 200);
});

test("getNextOffset stops at the final partial page", () => {
  const page = parsePaginatedServicesResponse(
    {
      services: new Array(34).fill({ protocol: "L402" }),
      total: 634,
      limit: 200,
      offset: 600,
    },
    600
  );

  assert.equal(getNextOffset(page), null);
});
