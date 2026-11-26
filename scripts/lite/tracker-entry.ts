import { completeTrackerEntry } from "../projects/complete-tracker-entry";

// The child receives only the checkout and its captured descriptor fingerprint.
await completeTrackerEntry(process.argv.slice(2));
