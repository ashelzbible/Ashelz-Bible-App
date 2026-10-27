export class HttpError extends Error {
  details?: unknown;
  status: number;
  code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}
export const badRequest = (code = 'bad_request', msg?: string) => new HttpError(400, code, msg);
export const unauthorized = (code = 'unauthorized', msg?: string) => new HttpError(401, code, msg);
export const forbidden = (code = 'forbidden', msg?: string) => new HttpError(403, code, msg);
export const notFound = (code = 'not_found', msg?: string) => new HttpError(404, code, msg);
export const conflict = (code = 'conflict', msg?: string) => new HttpError(409, code, msg);
export const tooMany = (code = 'rate_limited', msg?: string) => new HttpError(429, code, msg);
