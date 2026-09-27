import assert from "node:assert/strict";
import test from "node:test";
import { ActiveStreams } from "./active-streams.ts";

test("limits task and process concurrency and cancels only the selected connection", () => {
  const streams = new ActiveStreams();
  const controllers = Array.from({ length: 8 }, () => new AbortController());
  const unregister = controllers.map((controller, index) => streams.register(String(index), index < 4 ? "first" : "other", controller));
  assert.ok(unregister.every((callback) => callback !== null));
  assert.equal(streams.register("0", "first", new AbortController()), null);
  assert.equal(streams.register("overflow", "first", new AbortController()), null);
  streams.abortConnection("first");
  assert.deepEqual(controllers.map((controller) => controller.signal.aborted), [true, true, true, true, false, false, false, false]);
  unregister[0]!();
  const replacement = new AbortController();
  assert.ok(streams.register("0", "other", replacement));
  unregister[0]!();
  assert.equal(streams.register("overflow", "other", new AbortController()), null);
  streams.abortAll();
  assert.equal(replacement.signal.aborted, true);
  assert.equal(controllers.every((controller) => controller.signal.aborted), true);
});
