package mail

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
)

// BlockedPerson is someone the user blocked.
type BlockedPerson struct {
	Person
	BlockedAt time.Time `json:"blocked_at"`
}

// Block stops someone writing to the user directly: from now on, their direct mail lands
// in the user's Spam without an alert. Mail already received stays where it is. Groups
// are not affected.
func (s *Service) Block(ctx context.Context, userID int64, address string) (BlockedPerson, error) {
	var b BlockedPerson
	id, err := s.resolveAddress(ctx, s.DB, address)
	if errors.Is(err, ErrExternalMail) {
		// Someone outside PhoneMail (e.g. a Gmail address): blocking works for them too.
		err = s.tx(ctx, func(tx pgx.Tx) error {
			id, err = s.externalUser(ctx, tx, address, "")
			return err
		})
	}
	if err != nil {
		return b, err
	}
	if id == userID {
		return b, errBadRequest("You can't block yourself.")
	}
	if _, err := s.DB.Exec(ctx, `INSERT INTO blocks (user_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, userID, id); err != nil {
		return b, err
	}
	list, err := s.blocks(ctx, userID, &id)
	if err != nil || len(list) == 0 {
		return b, err
	}
	return list[0], nil
}

// Unblock lets someone write to the user normally again.
func (s *Service) Unblock(ctx context.Context, userID, blockedID int64) error {
	tag, err := s.DB.Exec(ctx, `DELETE FROM blocks WHERE user_id = $1 AND blocked_id = $2`, userID, blockedID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound("You haven't blocked that person.")
	}
	return nil
}

// Blocks lists the people the user blocked, newest first.
func (s *Service) Blocks(ctx context.Context, userID int64) ([]BlockedPerson, error) {
	return s.blocks(ctx, userID, nil)
}

func (s *Service) blocks(ctx context.Context, userID int64, only *int64) ([]BlockedPerson, error) {
	rows, err := s.DB.Query(ctx, `SELECT u.id, u.addr_key, u.display_name, u.avatar_url, b.created_at
		FROM blocks b JOIN users u ON u.id = b.blocked_id
		WHERE b.user_id = $1 AND ($2::bigint IS NULL OR b.blocked_id = $2)
		ORDER BY b.created_at DESC`, userID, only)
	if err != nil {
		return nil, err
	}
	return pgx.CollectRows(rows, func(r pgx.CollectableRow) (BlockedPerson, error) {
		var b BlockedPerson
		var local string
		err := r.Scan(&b.UserID, &local, &b.DisplayName, &b.AvatarURL, &b.BlockedAt)
		b.Address = s.AddressOf(local)
		return b, err
	})
}
