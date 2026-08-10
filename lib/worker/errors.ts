const CREDENTIALS_IN_URL = /:\/\/[^@\s]+@/g
const SECRET_ASSIGNMENT = /\b(password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)=([^\s&]+)/gi

export function sanitizeWorkerErrorMessage(message: string) {
  return message
    .replaceAll(CREDENTIALS_IN_URL, '://[REDACTED]@')
    .replaceAll(SECRET_ASSIGNMENT, '$1=[REDACTED]')
    .slice(0, 500)
}

export function serializeWorkerError(error: unknown) {
  return {
    name: sanitizeWorkerErrorMessage(error instanceof Error ? error.name : 'Error'),
    message: sanitizeWorkerErrorMessage(error instanceof Error ? error.message : 'Worker failed'),
  }
}
