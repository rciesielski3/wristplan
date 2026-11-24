import { describe, expect, it } from "vitest";
import { isActive } from "./activeNav";

describe("isActive", () => {
  it("matches root only exactly", () => {
    expect(isActive("/", "/")).toBe(true);
    expect(isActive("/workouts", "/")).toBe(false);
  });

  it("matches nested paths", () => {
    expect(isActive("/workouts", "/workouts")).toBe(true);
    expect(isActive("/workouts/new", "/workouts")).toBe(true);
    expect(isActive("/workouts/x/edit", "/workouts")).toBe(true);
  });

  it("does not match prefix lookalikes", () => {
    expect(isActive("/calendars", "/calendar")).toBe(false);
    expect(isActive("/dashboard", "/workouts")).toBe(false);
  });
});
