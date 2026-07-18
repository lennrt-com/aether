/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agentInstructions from "../agentInstructions.js";
import type * as auth from "../auth.js";
import type * as credentials from "../credentials.js";
import type * as crons from "../crons.js";
import type * as dashboard from "../dashboard.js";
import type * as events from "../events.js";
import type * as fingerprints from "../fingerprints.js";
import type * as health from "../health.js";
import type * as http from "../http.js";
import type * as jobs from "../jobs.js";
import type * as launchConfigs from "../launchConfigs.js";
import type * as lib_apiAuth from "../lib/apiAuth.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_ephemeralProfile from "../lib/ephemeralProfile.js";
import type * as lib_guards from "../lib/guards.js";
import type * as maintenance from "../maintenance.js";
import type * as mcpConnections from "../mcpConnections.js";
import type * as personas from "../personas.js";
import type * as ping from "../ping.js";
import type * as profiles from "../profiles.js";
import type * as proxies from "../proxies.js";
import type * as proxyPool from "../proxyPool.js";
import type * as sessions from "../sessions.js";
import type * as snapshots from "../snapshots.js";
import type * as tasks from "../tasks.js";
import type * as webhookDelivery from "../webhookDelivery.js";
import type * as webhooks from "../webhooks.js";
import type * as workers from "../workers.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agentInstructions: typeof agentInstructions;
  auth: typeof auth;
  credentials: typeof credentials;
  crons: typeof crons;
  dashboard: typeof dashboard;
  events: typeof events;
  fingerprints: typeof fingerprints;
  health: typeof health;
  http: typeof http;
  jobs: typeof jobs;
  launchConfigs: typeof launchConfigs;
  "lib/apiAuth": typeof lib_apiAuth;
  "lib/auth": typeof lib_auth;
  "lib/ephemeralProfile": typeof lib_ephemeralProfile;
  "lib/guards": typeof lib_guards;
  maintenance: typeof maintenance;
  mcpConnections: typeof mcpConnections;
  personas: typeof personas;
  ping: typeof ping;
  profiles: typeof profiles;
  proxies: typeof proxies;
  proxyPool: typeof proxyPool;
  sessions: typeof sessions;
  snapshots: typeof snapshots;
  tasks: typeof tasks;
  webhookDelivery: typeof webhookDelivery;
  webhooks: typeof webhooks;
  workers: typeof workers;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
