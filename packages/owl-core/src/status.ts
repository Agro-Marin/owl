
export const STATUS = {
  NEW: 0,
  MOUNTED: 1,
  DESTROYED: 2,
} as const;
export type StatusValue = (typeof STATUS)[keyof typeof STATUS];
