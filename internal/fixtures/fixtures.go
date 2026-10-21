// Package fixtures reads the synthetic test fixtures under testdata/, written
// in the shapes of real command output and state files; see
// testdata/README.md.
package fixtures

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// Path returns the path of the named fixture.
func Path(name string) string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..", "testdata", name)
}

// Read returns the named fixture's contents.
func Read(t testing.TB, name string) string {
	t.Helper()
	b, err := os.ReadFile(Path(name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
