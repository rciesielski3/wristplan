import { describe, expect, it, vi } from "vitest";

vi.mock("./scheduleDeps", () => ({ scheduleDeps: () => ({}) }));

import * as retry from "./api/schedule/[id]/retry/route";
import * as item from "./api/schedule/[id]/route";
import * as collection from "./api/schedule/route";

const verbs = (m: object) =>
  Object.keys(m)
    .filter((k) => /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(k))
    .sort();

describe("schedule route modules", () => {
  it("export only the intended HTTP methods so Next answers 405 for the rest", () => {
    expect(verbs(collection)).toEqual(["GET", "POST"]);
    expect(verbs(item)).toEqual(["DELETE", "PATCH"]);
    expect(verbs(retry)).toEqual(["POST"]);
  });
});
