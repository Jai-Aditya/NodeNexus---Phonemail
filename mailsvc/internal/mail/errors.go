package mail

import (
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5/pgconn"
)

// Error is a failure the caller should see: an HTTP status, a stable code and a message.
type Error struct {
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Message }

func errBadRequest(format string, a ...any) error {
	return &Error{400, "bad_request", fmt.Sprintf(format, a...)}
}
func errForbidden(format string, a ...any) error {
	return &Error{403, "forbidden", fmt.Sprintf(format, a...)}
}
func errNotFound(format string, a ...any) error {
	return &Error{404, "not_found", fmt.Sprintf(format, a...)}
}
func errConflict(code, format string, a ...any) error {
	return &Error{409, code, fmt.Sprintf(format, a...)}
}

var (
	ErrAlreadyReplied = &Error{409, "already_replied", "You've already replied to this message."}
	ErrGroupClash     = &Error{409, "group_exists", "A group with this name and these members already exists."}
	ErrExternalMail   = &Error{400, "external_disabled", "Sending to other email providers isn't enabled yet."}
	ErrAccountDeleted = &Error{410, "account_deleted", "This person deleted their PhoneMail account."}
	// The client should ask for a group name and send again with group_name.
	ErrGroupNameNeeded = &Error{400, "group_name_required", "Two or more people in To start a group: give the group a name."}
	ErrDraftScheduled  = &Error{409, "scheduled", "This email is scheduled to be sent. Cancel the scheduled send to change it."}
	ErrAlreadySent     = &Error{409, "already_sent", "It's already been sent."}
	ErrBlockedReaction = &Error{403, "forbidden", "You can't react to an email you were Bcc'd on."}
)

// errDryRun rolls back a checked send (sendOpts.dryRun); callers never see it.
var errDryRun = errors.New("dry run")

// errNotDue: the scheduler found the draft already taken back or rescheduled.
var errNotDue = errors.New("draft no longer due")

// uniqueViolation reports whether err is a unique-constraint failure on the named index.
func uniqueViolation(err error, constraint string) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == constraint
}
