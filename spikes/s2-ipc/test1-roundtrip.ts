// Test 1: structured round-trip fidelity, both directions.
import { deepEqual } from "./deepEqual";
import { deferred, withHardTimeout } from "./timeout";

const complexObj = {
  id: 42,
  name: "flow-42",
  createdAt: new Date("2024-03-14T12:34:56.789Z"),
  tags: ["ipc", "spike", "flowbun"],
  nested: {
    retries: 3,
    active: true,
    meta: {
      list: [1, 2, { deep: "value", when: new Date(2000, 0, 1) }],
      empty: null,
    },
  },
  history: [
    { ts: new Date("2023-01-01T00:00:00.000Z"), event: "created" },
    { ts: new Date("2023-06-15T08:00:00.000Z"), event: "updated" },
  ],
};

const gotReply = deferred<any>();

const child = Bun.spawn({
  cmd: ["bun", "run", `${import.meta.dir}/child.ts`, "roundtrip"],
  ipc(message) {
    gotReply.resolve(message);
  },
  stdio: ["ignore", "inherit", "inherit"],
});

child.send({ type: "ping", payload: complexObj });

try {
  const reply = await withHardTimeout(gotReply.promise, 10_000, "waiting for child roundtrip reply");

  // parent -> child -> parent: does the object we sent survive the round trip unchanged?
  const parentToChildOk = deepEqual(reply.echoed, complexObj);
  // Also confirm it's really a Date instance after the trip, not a string.
  const dateInstanceOk = reply.echoed.createdAt instanceof Date;

  // child -> parent: does a complex object built in the child (with its own Date) arrive intact?
  const expectedChildObj = {
    id: 999,
    name: "child-generated-object",
    createdAt: new Date("2021-11-05T09:00:00.000Z"),
    nested: {
      depth: 2,
      values: [1, 2, { deep: "value", when: new Date(2000, 0, 1) }],
      nullable: null,
    },
    flags: [true, false, true],
  };
  const childToParentOk = deepEqual(reply.childObj, expectedChildObj);
  const childDateInstanceOk = reply.childObj.createdAt instanceof Date;

  console.log("parent->child->parent deep equal:", parentToChildOk);
  console.log("parent->child->parent createdAt instanceof Date:", dateInstanceOk);
  console.log("child->parent deep equal:", childToParentOk);
  console.log("child->parent createdAt instanceof Date:", childDateInstanceOk);

  const pass = parentToChildOk && dateInstanceOk && childToParentOk && childDateInstanceOk;
  console.log("TEST1_RESULT:", pass ? "PASS" : "FAIL");
} catch (err) {
  console.log("TEST1_RESULT: FAIL (exception)", err);
} finally {
  child.kill();
  await child.exited;
}
