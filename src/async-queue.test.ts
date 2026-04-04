/*
 * Copyright 2026 StayBlue
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { expect, test } from "bun:test";
import { AsyncQueue } from "./async-queue.ts";

test("push and close yields all values in order", async () => {
  const queue = new AsyncQueue<number>();
  queue.push(1);
  queue.push(2);
  queue.push(3);
  queue.close();

  const values: number[] = [];
  for await (const value of queue) {
    values.push(value);
  }

  expect(values).toEqual([1, 2, 3]);
});

test("push after close is a no-op", async () => {
  const queue = new AsyncQueue<number>();
  queue.push(1);
  queue.close();
  queue.push(2);

  const values: number[] = [];
  for await (const value of queue) {
    values.push(value);
  }

  expect(values).toEqual([1]);
});

test("fail causes next to throw after buffered items are consumed", async () => {
  const queue = new AsyncQueue<number>();
  queue.push(1);
  queue.fail(new Error("queue error"));

  const first = await queue.next();
  expect(first).toEqual({ value: 1, done: false });

  await expect(queue.next()).rejects.toThrow("queue error");
});

test("throw propagates error to caller", async () => {
  const queue = new AsyncQueue<number>();
  const error = new Error("thrown");

  await expect(queue.throw(error)).rejects.toThrow("thrown");
});

test("next waits for push when queue is empty", async () => {
  const queue = new AsyncQueue<number>();

  const nextPromise = queue.next();
  queue.push(42);

  const result = await nextPromise;
  expect(result).toEqual({ value: 42, done: false });

  queue.close();
});

test("return closes the queue and signals done", async () => {
  const queue = new AsyncQueue<number>();

  const result = await queue.return();
  expect(result).toEqual({ value: undefined, done: true });
});
