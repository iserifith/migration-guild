# Common Python modernization mappings

- Python 2 syntax and builtins become supported Python 3 equivalents, with behavior captured before conversion.
- `setup.py` metadata becomes standards-based `pyproject.toml` configuration and a build backend.
- Flat or implicit package layouts become an explicit `src/` layout with importable packages.
- Flask routes may become FastAPI path operations when typed validation and an ASGI target are required; otherwise upgrade Flask without changing frameworks gratuitously.
- Django applications retain Django conventions unless the approved target architecture requires decomposition.
- Pylons applications may become FastAPI path operations when typed validation and an ASGI target are required, mirroring the Flask migration path.
- `optparse` becomes `argparse`; `imp` becomes `importlib`; `distutils` usage moves to the selected build backend.
- `unittest` suites may remain valid, but new and migrated tests should use pytest conventions and fixtures.
