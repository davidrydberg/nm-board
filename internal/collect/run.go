package collect

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Cmd is one external command fleetwatch runs. Env is added to the inherited
// environment.
type Cmd struct {
	Name string
	Args []string
	Dir  string
	Env  map[string]string
}

// Result carries stdout even alongside an error, so callers can still parse
// output from a command that exited non-zero. Error is "" on success.
type Result struct {
	Stdout string
	Error  string
}

// Runner runs a command to completion or until timeout passes.
type Runner func(cmd Cmd, timeout time.Duration) Result

// lockedBuffer is written by exec's copying goroutine and read on timeout.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// ExecRunner runs commands as child processes in their own process group. On
// timeout it kills the whole group, so a script's own children cannot outlive
// the bound or hold its output open.
func ExecRunner(c Cmd, timeout time.Duration) Result {
	name := filepath.Base(c.Name)
	cmd := exec.Command(c.Name, c.Args...)
	cmd.Dir = c.Dir
	cmd.Env = os.Environ()
	for k, v := range c.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	var stdout, stderr lockedBuffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		return Result{Error: fmt.Sprintf("%s: %v", name, err)}
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case err := <-done:
		if err == nil {
			return Result{Stdout: stdout.String()}
		}
		why, _, _ := strings.Cut(strings.TrimSpace(stderr.String()), "\n")
		if why == "" {
			why = err.Error()
		}
		return Result{Stdout: stdout.String(), Error: name + ": " + why}
	case <-timer.C:
		_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		// Return even if a stray descendant keeps the pipes open.
		return Result{Stdout: stdout.String(), Error: name + ": timed out"}
	}
}
