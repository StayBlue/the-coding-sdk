# the-coding-sdk

[![CI](https://img.shields.io/github/actions/workflow/status/StayBlue/the-coding-sdk/ci.yml?branch=main&style=flat-square)](https://github.com/StayBlue/the-coding-sdk/actions/workflows/ci.yml) [![API Surface Coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/StayBlue/c211434e1cf8e4e23f17e8006350e964/raw/api-surface-badge.json&style=flat-square)](https://gist.github.com/StayBlue/c211434e1cf8e4e23f17e8006350e964) [![Upstream SDK](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/StayBlue/c211434e1cf8e4e23f17e8006350e964/raw/upstream-sdk-badge.json&style=flat-square)](https://gist.github.com/StayBlue/c211434e1cf8e4e23f17e8006350e964) [![npm](https://img.shields.io/npm/v/the-coding-sdk?style=flat-square)](https://www.npmjs.com/package/the-coding-sdk) [![JSR](https://jsr.io/badges/@stayblue/the-coding-sdk?style=flat-square)](https://jsr.io/@stayblue/the-coding-sdk)

An open-source implementation of an SDK.

> [!IMPORTANT]
>
> While I am relatively confident in the API at this point, there are still runtime behaviors that are not fully validated. Use at your own risk.

## Usage

```ts
import { query } from "the-coding-sdk";

let finalResult = "";

for await (const message of query({
  prompt: "Write a concise changelog entry for the current repository.",
  cwd: process.cwd(),
})) {
  if (message.type === "assistant") {
    const content = message.message["content"];
    if (typeof content === "string") {
      process.stdout.write(content);
    }
  }

  if (message.type === "result") {
    finalResult = message.result;
  }
}

console.log("\n\nFinal result:", finalResult);
```

## Background

This project grew out of a need for an SDK that could be fixed directly, instead of working around issues with brittle hacks.

It was built primarily by referencing the official Python SDK and using types from the TypeScript SDK. Where information was missing in either, behavior was derived through reverse-engineering of the TypeScript SDK.

Based on my rudimentary understanding of the Terms of Service, given that this is simply a wrapper around the CLI, there shouldn't be any issues.

> [!WARNING]
>
> This can still get your account banned. Official communication around this has been unreliable. See [this tweet](https://x.com/mattpocockuk/status/2040536403289764275).

That said, both the official SDK and this SDK still depend on the closed-source CLI. If the problem lives in the CLI itself, it cannot be fixed here.

## License

This project is licensed under the Apache License, Version 2.0. You are free to use this project as you see fit, so long as you comply with the license's terms.
