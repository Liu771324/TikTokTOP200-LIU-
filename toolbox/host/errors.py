class ToolboxError(Exception):
    def __init__(self, code, message, *, retryable=False, details=None):
        super().__init__(message)
        self.code = code
        self.retryable = retryable
        self.details = details or {}

    def as_dict(self):
        return {"code": self.code, "message": str(self),
                "retryable": self.retryable, "details": self.details}
