"""Document engine: OfficeCLI, LibreOffice conversion, PDF editing and drafts.

The client agent calls these capabilities through ``POST /api/tools/file``. All
engine work happens in short-lived child processes or in-process PDF operations;
nothing here runs an agent loop.
"""
