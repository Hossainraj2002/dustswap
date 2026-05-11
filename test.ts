import { normalizeQuestTimestamp } from './apps/api/src/services/questEngine';
console.log(normalizeQuestTimestamp("1778480000000"));
console.log(normalizeQuestTimestamp(1778480000000));
console.log(normalizeQuestTimestamp(new Date("2026-05-13T12:00:00Z")));
console.log(normalizeQuestTimestamp("2026-05-13T12:00:00Z"));
console.log(normalizeQuestTimestamp(null));
console.log(normalizeQuestTimestamp(""));
