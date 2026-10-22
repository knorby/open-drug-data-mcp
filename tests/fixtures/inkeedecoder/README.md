# INKEEDecoder fixtures

These fixtures are **raw HTML pages captured live** from inkeedecoder.com on
2026-10-22, with a descriptive `open-drug-data-mcp-test/0.0.0` user agent and no
query parameters beyond those shown. They pin this server's mapping to the
pages the site actually served; they are not hand-authored.

| File | Request |
| --- | --- |
| `search-niacinamide.html` | `/search?query=niacinamide` (both tabs) |
| `search-zero.html` | `/search?query=zzzznonexistentzzzz` (zero hits, both tabs) |
| `search-products-niacinamide.html` | `/search/product?query=&include=Niacinamide` |
| `search-products-zero.html` | `/search/product?query=&include=zzzznonexistentzzzz` |
| `ingredient-niacinamide.html` | `/ingredients/niacinamide` (CosIng panel present) |
| `product-the-inkey-list-niacinamide.html` | `/products/the-inkey-list-niacinamide` |

The pages include the site's own analytics scripts and asset links because the
capture is not rewritten. They are test input only, never surfaced in tool
output, and Biome ignores HTML under `tests/fixtures/` so upstream markup is
not reformatted.
