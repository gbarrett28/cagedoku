from collections.abc import Callable
from typing import Any, TypeVar, overload

_F = TypeVar("_F", bound=Callable[..., Any])


def get_num_threads() -> int: ...
def set_num_threads(n: int) -> None: ...
def prange(start: int, stop: int = ..., step: int = ...) -> range: ...


@overload
def njit(func: _F) -> _F: ...
@overload
def njit(
    func: None = None,
    *,
    nopython: bool = True,
    cache: bool = False,
    parallel: bool = False,
    fastmath: bool = False,
    nogil: bool = False,
    **kwargs: Any,
) -> Callable[[_F], _F]: ...
