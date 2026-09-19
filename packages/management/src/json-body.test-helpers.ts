/**
 * TEST-ONLY loose typing for HTTP JSON bodies.
 *
 * `Response.json()` is typed `Promise<unknown>`, so every `await res.json()` in
 * a test is an error under `tsc --noEmit`. Casting each body to a hand-written
 * response shape is churn no assertion benefits from, and `any` would disable
 * checking inside the assertion too. `JsonBody` keeps property reads (including
 * nested ones like `body.config.model`) legal while still being a real type:
 * arithmetic, string methods and iteration on a body still fail to compile, so
 * a test that means to read a number or a list must say so.
 *
 * Not exported from the package entry; nothing outside `*.test.ts` imports it.
 */
export interface JsonBody {
  [key: string]: JsonBody;
}
