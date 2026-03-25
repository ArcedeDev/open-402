export interface PaginatedApiResponse<T> {
  items: T[];
  total: number | null;
  limit: number | null;
  offset: number;
}

export function parsePaginatedServicesResponse<T>(
  payload: unknown,
  requestedOffset: number
): PaginatedApiResponse<T> {
  const objectPayload =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : null;

  const items = Array.isArray(payload)
    ? payload as T[]
    : Array.isArray(objectPayload?.services)
      ? objectPayload.services as T[]
      : Array.isArray(objectPayload?.data)
        ? objectPayload.data as T[]
        : [];

  const readNumber = (key: string): number | null => {
    const value = objectPayload?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  };

  return {
    items,
    total: readNumber("total") ?? readNumber("totalCount") ?? readNumber("count"),
    limit: readNumber("limit") ?? readNumber("pageSize"),
    offset: readNumber("offset") ?? requestedOffset,
  };
}

export function getNextOffset(page: PaginatedApiResponse<unknown>): number | null {
  if (page.items.length === 0) return null;

  const step = page.items.length;
  const nextOffset = page.offset + step;

  if (page.total != null && nextOffset >= page.total) {
    return null;
  }

  return nextOffset;
}
