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

export class AsyncQueue<T> implements AsyncIterable<T>, AsyncIterator<T> {
  #values: T[] = [];
  #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #error: unknown;
  #closed = false;

  push(value: T): void {
    if (this.#closed) {
      return;
    }

    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }

    this.#values.push(value);
  }

  fail(error: unknown): void {
    if (this.#closed) {
      return;
    }
    this.#error = error;
    this.close();
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    while (this.#waiters.length > 0) {
      const waiter = this.#waiters.shift();
      waiter?.({ value: undefined, done: true });
    }
  }

  async next(): Promise<IteratorResult<T>> {
    if (this.#values.length > 0) {
      return {
        value: this.#values.shift() as T,
        done: false,
      };
    }

    if (this.#closed) {
      if (this.#error) {
        throw this.#error;
      }
      return {
        value: undefined,
        done: true,
      };
    }

    return await new Promise<IteratorResult<T>>((resolve) => {
      this.#waiters.push(resolve);
    }).then((result) => {
      if (result.done && this.#error) {
        throw this.#error;
      }
      return result;
    });
  }

  async return(): Promise<IteratorResult<T>> {
    this.close();
    return {
      value: undefined,
      done: true,
    };
  }

  async throw(error?: unknown): Promise<IteratorResult<T>> {
    this.fail(error);
    throw error;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}
