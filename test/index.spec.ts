import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("Reserve backend worker root endpoint", () => {
	it("responds with root welcome json (unit style)", async () => {
		const request = new IncomingRequest("http://example.com");
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		expect(await response.text()).toMatchInlineSnapshot(
			`"{"success":true,"data":{"endpoints":["/api/users","/api/login","/api/liff-login","/api/line-login","/api/appointments","/api/beauticians","/api/holidays","/api/line-webhook"]},"message":"歡迎來到預約系統 API 伺服器！"}"`
		);
	});

	it("responds with root welcome json (integration style)", async () => {
		const response = await SELF.fetch("https://example.com");
		expect(await response.text()).toMatchInlineSnapshot(
			`"{\\"success\\":true,\\"data\\":{\\"endpoints\\":[\\"/api/users\\",\\"/api/login\\",\\"/api/liff-login\\",\\"/api/line-login\\",\\"/api/appointments\\",\\"/api/beauticians\\",\\"/api/holidays\\",\\"/api/line-webhook\\"]},\\"message\\":\\"歡迎來到預約系統 API 伺服器！\\"}"`
		);
	});
});
