/**
 * Importing this module registers every action. Command handlers in
 * `src/bot/index.ts` and the handler files register their patterns with
 * `registerCommandActions` afterwards.
 */
import "./reports";
import "./deal";
import "./aiCoach";
import "./help";
import "./admin";
import "./inputFlows";
