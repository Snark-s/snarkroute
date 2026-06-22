export const apiFetch = (input: RequestInfo | URL, init: RequestInit = {}) => fetch(input, { credentials: "include", ...init });
