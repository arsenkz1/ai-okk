-- Preserve historical rollout slots 1..3 and add five new slots 4..8 for
-- the post-history-fence test. No existing action or slot row is changed.
ALTER TABLE "CallStageAutomationTestSlot"
  DROP CONSTRAINT "CallStageAutomationTestSlot_slotNumber_check";

ALTER TABLE "CallStageAutomationTestSlot"
  ADD CONSTRAINT "CallStageAutomationTestSlot_slotNumber_check"
  CHECK ("slotNumber" BETWEEN 1 AND 8);
