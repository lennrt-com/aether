/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as crons from "../crons.js";
import type * as events from "../events.js";
import type * as health from "../health.js";
import type * as launchConfigs from "../launchConfigs.js";
import type * as lib_guards from "../lib/guards.js";
import type * as personas from "../personas.js";
import type * as ping from "../ping.js";
import type * as profiles from "../profiles.js";
import type * as proxies from "../proxies.js";
import type * as snapshots from "../snapshots.js";
import type * as tasks from "../tasks.js";
import type * as workers from "../workers.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  crons: typeof crons;
  events: typeof events;
  health: typeof health;
  launchConfigs: typeof launchConfigs;
  "lib/guards": typeof lib_guards;
  personas: typeof personas;
  ping: typeof ping;
  profiles: typeof profiles;
  proxies: typeof proxies;
  snapshots: typeof snapshots;
  tasks: typeof tasks;
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
