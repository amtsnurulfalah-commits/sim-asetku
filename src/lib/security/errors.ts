export class AppError extends Error {
  constructor(
    public code: string,
    public status: number,
    public publicMessage: string,
  ) {
    super(code);
    this.name = "AppError";
  }
}
export const unauthorized = () =>
  new AppError("SESSION_INVALID", 401, "Sesi berakhir. Silakan masuk kembali.");
export const unavailable = () =>
  new AppError(
    "SERVICE_UNAVAILABLE",
    503,
    "Layanan belum dapat dihubungi. Silakan coba kembali.",
  );
