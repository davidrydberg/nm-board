package fleet

// TOON is the token-oriented notation that `no-mistakes axi` prints. This is a
// reader for the subset that command emits: two-space indented objects,
// `key: value` scalars, `key[N]{a,b}:` tables whose rows follow one level
// deeper, and `key[N]: a,b` inline arrays. Objects decode to Toon, tables to
// []map[string]string, inline arrays to []string, and scalars to strings.

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// Toon is one decoded TOON object.
type Toon map[string]any

var arrayHeader = regexp.MustCompile(`^([^\[\]:{}]+)\[(\d+)\](?:\{([^}]*)\})?:(.*)$`)

type toonLine struct {
	indent int
	text   string
}

// ParseToon decodes a TOON document.
func ParseToon(doc string) (Toon, error) {
	var lines []toonLine
	for _, raw := range strings.Split(strings.ReplaceAll(doc, "\r\n", "\n"), "\n") {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		text := strings.TrimLeft(raw, " ")
		lines = append(lines, toonLine{indent: len(raw) - len(text), text: text})
	}
	obj, next, err := parseToonObject(lines, 0, 0)
	if err != nil {
		return nil, err
	}
	if next != len(lines) {
		return nil, fmt.Errorf("toon: unexpected indentation at %q", lines[next].text)
	}
	return obj, nil
}

func parseToonObject(lines []toonLine, start, indent int) (Toon, int, error) {
	obj := Toon{}
	i := start
	for i < len(lines) {
		line := lines[i]
		if line.indent < indent {
			break
		}
		if line.indent > indent {
			return nil, 0, fmt.Errorf("toon: unexpected indentation at %q", line.text)
		}
		if h := arrayHeader.FindStringSubmatch(line.text); h != nil {
			key := strings.TrimSpace(h[1])
			if h[3] != "" {
				fields := splitRow(h[3])
				rows := []map[string]string{}
				i++
				for i < len(lines) && lines[i].indent > indent {
					cells := splitRow(lines[i].text)
					row := map[string]string{}
					for k, f := range fields {
						if k < len(cells) {
							row[f] = cells[k]
						}
					}
					rows = append(rows, row)
					i++
				}
				obj[key] = rows
				continue
			}
			rest := strings.TrimSpace(h[4])
			if rest == "" {
				obj[key] = []string{}
			} else {
				obj[key] = splitRow(rest)
			}
			i++
			continue
		}
		colon := strings.Index(line.text, ":")
		if colon < 0 {
			return nil, 0, fmt.Errorf("toon: expected key at %q", line.text)
		}
		key := strings.TrimSpace(line.text[:colon])
		value := strings.TrimSpace(line.text[colon+1:])
		if value == "" && i+1 < len(lines) && lines[i+1].indent > indent {
			nested, next, err := parseToonObject(lines, i+1, lines[i+1].indent)
			if err != nil {
				return nil, 0, err
			}
			obj[key] = nested
			i = next
			continue
		}
		obj[key] = unquote(value)
		i++
	}
	return obj, i, nil
}

// splitRow splits a comma-delimited row, honouring double-quoted cells.
func splitRow(s string) []string {
	var cells []string
	var cur strings.Builder
	inQuote := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case inQuote && c == '\\' && i+1 < len(s):
			cur.WriteByte(c)
			cur.WriteByte(s[i+1])
			i++
		case c == '"':
			inQuote = !inQuote
			cur.WriteByte(c)
		case c == ',' && !inQuote:
			cells = append(cells, unquote(strings.TrimSpace(cur.String())))
			cur.Reset()
		default:
			cur.WriteByte(c)
		}
	}
	return append(cells, unquote(strings.TrimSpace(cur.String())))
}

func unquote(s string) string {
	if len(s) >= 2 && strings.HasPrefix(s, `"`) && strings.HasSuffix(s, `"`) {
		var v string
		if json.Unmarshal([]byte(s), &v) == nil {
			return v
		}
		// Not valid JSON escaping; fall back to stripping the quotes.
		return s[1 : len(s)-1]
	}
	return s
}

// String returns the scalar at key, or "".
func (t Toon) String(key string) string {
	v, _ := t[key].(string)
	return v
}

// Object returns the nested object at key, or nil.
func (t Toon) Object(key string) Toon {
	v, _ := t[key].(Toon)
	return v
}

// Table returns the table rows at key, or nil.
func (t Toon) Table(key string) []map[string]string {
	v, _ := t[key].([]map[string]string)
	return v
}

// List returns the inline array at key, or nil.
func (t Toon) List(key string) []string {
	v, _ := t[key].([]string)
	return v
}
