"""Tamas - a unified language for data, code and measurement. Reference implementation v0.1."""
__version__ = "0.1.0"
from .errors import TamasError
from .interp import Interp, run_source, run_file
