/** Số liệu quy định — nguồn duy nhất cho chặn đơn và RAG. */
export const POLICY = {
  leave: {
    annual: {
      totalDaysPerYear: 12,
      minAdvanceDays: 1,
      maxConsecutiveDays: 5,
    },
    sick: {
      minAdvanceDays: 0,
      maxDaysPerRequest: 3,
    },
    unpaid: {
      minAdvanceDays: 3,
      maxDaysPerRequest: 10,
    },
    blackout: { fromMd: "12-25", toMd: "12-31" },
  },
  trip: {
    minPurposeLength: 10,
    maxDays: 7,
    respectBlackout: true,
  },
} as const;
