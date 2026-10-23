"""Local extension hook. See docs/MODEL_ADAPTERS.md for working examples."""


def register() -> None:
    # Register trusted Python adapters here. Never import a client-provided path.
    # Existing defaults require no registration and remain lazy/offline-first.
    pass
