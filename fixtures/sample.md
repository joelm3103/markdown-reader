# markdown-reader fixture

A file that exercises every element the preview is expected to render. Used by
`scripts/smoke.js` and handy for eyeballing all four view modes.

## Inline formatting

Plain text with **bold**, *italic*, ~~strikethrough~~, `inline code`, a
[reference link][ref], an [inline link](https://example.com/inline), and an
autolink <https://example.com/auto>.

### Third level heading

A paragraph directly under a third level heading, so all three heading levels
are exercised by the round-trip check.

## Lists

Unordered:

- first item
- second item with **bold** and `code`
- third item

Ordered:

1. step one
2. step two
   1. nested step
   2. another nested step
3. step three

Task list:

- [x] completed task
- [ ] outstanding task

## Table

| Element | Split | Preview | Source |
| --- | --- | --- | --- |
| Headings | yes | yes | yes |
| Tables | yes | yes | yes |
| Code | yes | yes | yes |

## Code

```js
// Fenced block with a known language: highlight.js should tag these tokens.
const anchors = [1, 3, 5]
function mapLine(line) {
  return anchors.filter((anchor) => anchor <= line).length
}
export default mapLine
```

```python
def greet(name: str) -> str:
    return f"hello {name}"
```

```
Plain fenced block with no language: rendered unstyled rather than guessed.
```

## Blockquote

> A quoted line.
>
> A second paragraph inside the quote.

## Rule and image

---

![Local image placeholder](./does-not-exist.png)

## Reference definition

The definition itself should not render as visible text.

[ref]: https://example.com/reference
