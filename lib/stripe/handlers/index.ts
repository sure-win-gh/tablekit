// Barrel — registers every webhook handler via side-effect imports.
// Import this once at the top of the webhook route so the dispatch
// map is populated.

import "./account-updated";
import "./payment-intent-succeeded";
import "./payment-intent-failed";
import "./charge-refunded";
import "./setup-intent-succeeded";
import "./setup-intent-failed";

export {};
