"""Limit collection to the URLs selected by the configured source adapters."""

from urllib.request import HTTPRedirectHandler, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


open_source = build_opener(NoRedirect()).open
