package mail

import (
	"context"
	"strings"
	"time"
	"unicode/utf8"
)

// Custom folders: each person's own named folders for chats. A chat is filed in at most one
// folder (ChatAction "move"); that also archives it, so it leaves Home, and new mail brings it
// back to Home while it stays in its folder. A folder's chats are listed with the Home filter
// "folder:<id>". Deleting a folder leaves its chats archived. Nobody else sees your folders.

const (
	MaxFolders    = 50
	MaxFolderName = 40
)

// Folder is one of the user's folders, with how many chats it holds and their unread emails.
type Folder struct {
	ID          int64     `json:"id"`
	Name        string    `json:"name"`
	ChatCount   int       `json:"chat_count"`
	UnreadCount int       `json:"unread_count"`
	CreatedAt   time.Time `json:"created_at"`
}

// The built-in places; a folder can't take one of their names.
var reservedFolderNames = map[string]bool{
	"inbox": true, "home": true, "unread": true, "starred": true, "favourites": true, "favorites": true,
	"snoozed": true, "archived": true, "all mail": true, "drafts": true, "scheduled": true,
	"spam": true, "trash": true, "sent": true,
}

func folderName(name string) (string, error) {
	n := strings.Join(strings.Fields(name), " ")
	if n == "" {
		return "", errBadRequest("Give the folder a name.")
	}
	if utf8.RuneCountInString(n) > MaxFolderName {
		return "", errBadRequest("A folder name can be at most %d characters.", MaxFolderName)
	}
	if reservedFolderNames[strings.ToLower(n)] {
		return "", errBadRequest("%q is already a built-in place. Choose another name.", n)
	}
	return n, nil
}

// Folders lists the user's folders, A to Z.
func (s *Service) Folders(ctx context.Context, userID int64) ([]Folder, error) {
	rows, err := s.DB.Query(ctx, `
		SELECT f.id, f.name, f.created_at,
		       count(uc.conversation_id) FILTER (WHERE uc.last_message_id IS NOT NULL)::int,
		       coalesce(sum(uc.unread_count), 0)::int
		FROM user_folders f
		LEFT JOIN user_conversations uc ON uc.user_id = f.user_id AND uc.folder_id = f.id
		WHERE f.user_id = $1
		GROUP BY f.id
		ORDER BY lower(f.name), f.id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []Folder{}
	for rows.Next() {
		var f Folder
		if err := rows.Scan(&f.ID, &f.Name, &f.CreatedAt, &f.ChatCount, &f.UnreadCount); err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// CreateFolder makes a new, empty folder.
func (s *Service) CreateFolder(ctx context.Context, userID int64, name string) (Folder, error) {
	n, err := folderName(name)
	if err != nil {
		return Folder{}, err
	}
	f := Folder{Name: n}
	var count int
	if err := s.DB.QueryRow(ctx, `SELECT count(*) FROM user_folders WHERE user_id = $1`, userID).Scan(&count); err != nil {
		return Folder{}, err
	}
	if count >= MaxFolders {
		return Folder{}, errBadRequest("You can have at most %d folders.", MaxFolders)
	}
	err = s.DB.QueryRow(ctx, `INSERT INTO user_folders (user_id, name) VALUES ($1, $2) RETURNING id, created_at`,
		userID, n).Scan(&f.ID, &f.CreatedAt)
	if uniqueViolation(err, "user_folders_name_uniq") {
		return Folder{}, errConflict("folder_exists", "You already have a folder called %q.", n)
	}
	if err != nil {
		return Folder{}, err
	}
	_ = s.notifyUser(ctx, userID, "chats", 0)
	return f, nil
}

// RenameFolder gives a folder a new name; its chats stay in it.
func (s *Service) RenameFolder(ctx context.Context, userID, folderID int64, name string) error {
	n, err := folderName(name)
	if err != nil {
		return err
	}
	tag, err := s.DB.Exec(ctx, `UPDATE user_folders SET name = $3 WHERE id = $1 AND user_id = $2`, folderID, userID, n)
	if uniqueViolation(err, "user_folders_name_uniq") {
		return errConflict("folder_exists", "You already have a folder called %q.", n)
	}
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound("Folder not found.")
	}
	_ = s.notifyUser(ctx, userID, "chats", 0)
	return nil
}

// DeleteFolder removes a folder. Its chats stay archived (in All mail); no email is deleted.
func (s *Service) DeleteFolder(ctx context.Context, userID, folderID int64) error {
	tag, err := s.DB.Exec(ctx, `DELETE FROM user_folders WHERE id = $1 AND user_id = $2`, folderID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return errNotFound("Folder not found.")
	}
	_ = s.notifyUser(ctx, userID, "chats", 0)
	return nil
}
