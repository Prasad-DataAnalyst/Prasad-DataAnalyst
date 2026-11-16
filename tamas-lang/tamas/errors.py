class TamasError(Exception):
    """Any error a Tamas program can produce, with the source line when known."""

    def __init__(self, msg, line=None):
        super().__init__(msg)
        self.msg = msg
        self.line = line

    def __str__(self):
        return f"line {self.line}: {self.msg}" if self.line else self.msg
