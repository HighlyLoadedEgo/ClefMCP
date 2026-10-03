# Used by Glama.ai (and other MCP directories) to build and introspect the
# server: the container starts clef-mcp on stdio and answers MCP initialize /
# tools/list without needing the model installed.
FROM node:22-alpine

RUN npm install -g clef-mcp@0.1.6

ENTRYPOINT ["clef-mcp"]
