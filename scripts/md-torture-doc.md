# Header 1: Heading & Typography Test

## Header 2: Sub-heading (`h2`)

### Header 3: Sub-sub-heading (`h3`)

#### Header 4: Deep nesting (`h4`)

Paragraphs can include **bold text**, *italic text*, ***bold and italic text***, `inline code`, and ~~strikethrough text~~. You can also include footnotes[^1] and abbreviations.

---

## Blockquotes & Callouts

> This is a standard blockquote. It can span multiple lines to test how the editor handles spacing, borders, and background shading.
> > This is a nested blockquote. Good editors will style this recursively to show depth.
> > — *Famous Author*
> 

---

## Lists & Task Lists

### Ordered List

1. First item
   1. Sub-item A
   2. Sub-item B
2. Second item
   1. Nested numerical flow
3. Third item

### Unordered List

* Bullet item one
  * Nested bullet item
    * Deeply nested bullet item
* Bullet item two
* Bullet item three

### Task List (Checkboxes)

* [x] Completed task item
* [ ] Incomplete task item
* [ ] Another pending task with `inline code` inside

---

## Tables

| Header 1 (Left) | Header 2 (Center) | Header 3 (Right) |
| --- | :---: | ---: |
| Cell content | Centered data | Right-aligned |
| Row 2, Col 1 | **Bold** text | 123.45 |
| Row 3, Col 1 | *Italic* text | 9,876.50 |

---

## Code Blocks & Syntax Highlighting

### JavaScript / TypeScript

```typescript
interface User {
  id: number;
  name: string;
  isActive: boolean;
}

const fetchUser = async (id: number): Promise<User> => {
  const response = await fetch(`https://api.example.com/users/${id}`);
  if (!response.ok) {
    throw new Error("Failed to fetch user");
  }
  return response.json();
};

```

### Python

```python
def fibonacci(n: int) -> list[int]:
    """Generate a Fibonacci sequence up to n terms."""
    sequence = [0, 1]
    while len(sequence) < n:
        sequence.append(sequence[-1] + sequence[-2])
    return sequence

print(fibonacci(10))

```

---

## Math & Scientific Formulas

For inline math, use single dollar signs: The quadratic formula is given by $x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}$.

For block-level equations, use double dollar signs:

$$\int_{0}^{\infty} e^{-x^2} dx = \frac{\sqrt{\pi}}{2}$$

$$f(x) = \sum_{n=0}^{\infty} \frac{f^{(n)}(a)}{n!} (x - a)^n$$

---

## Links, Images, and HTML Elements

* [External Link Example](https://www.example.com)
* [Reference-style link](https://www.markdown.org)

Here is a placeholder image tag test:

![A placeholder image](https://via.placeholder.com/350x150.png "Placeholder title")

An HTML image tag stays escaped text: <img src="placeholder.png" alt="placeholder" width="350" height="150" />

---

[^1]: This is the footnote definition at the bottom of the document to test footnote referencing features.
