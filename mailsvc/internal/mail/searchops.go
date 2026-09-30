package mail

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// Search operators, as in Gmail:
//
//	from:asha  from:me  to:9876543210  to:"Goa crew"  has:attachment
//	before:2026-09-01  after:2026-08-01  in:inbox|sent|spam|trash|archived|anywhere
//	is:unread  is:read  is:starred
//
// Without in:, spam and trash are left out (like Gmail). Dates are days in India time;
// before: is up to the start of that day, after: from the start of that day.
type searchFilter struct {
	text  string   // what's left: searched as words
	conds []string // SQL conditions on mb (mailbox) and m (messages)
	args  []any    // their arguments, numbered from $2 ($1 is the user)
	ops   bool     // an operator was used: list matches even without words
}

var searchOpRe = regexp.MustCompile(`(?i)(?:^|\s)(from|to|has|before|after|in|is):("[^"]*"|\S+)`)

// India Standard Time has no daylight saving, so a fixed zone is exact.
var searchZone = time.FixedZone("IST", 5*3600+1800)

func (s *Service) parseSearch(ctx context.Context, userID int64, q string) (searchFilter, error) {
	var f searchFilter
	arg := func(v any) string {
		f.args = append(f.args, v)
		return fmt.Sprintf("$%d", len(f.args)+1)
	}
	folder := "mb.folder = 'inbox'"
	var bad error
	f.text = searchOpRe.ReplaceAllStringFunc(q, func(m string) string {
		sub := searchOpRe.FindStringSubmatch(m)
		op, val := strings.ToLower(sub[1]), strings.Trim(sub[2], `"`)
		f.ops = true
		lv := strings.ToLower(val)
		switch op {
		case "from":
			if lv == "me" {
				f.conds = append(f.conds, "mb.is_mine")
			} else if strings.Contains(lv, "@") && !s.ourDomain(lv) {
				// Someone outside PhoneMail, by their email address.
				f.conds = append(f.conds, "m.sender_id IN (SELECT id FROM users WHERE external_address = "+arg(lv)+")")
			} else if id, err := s.resolveAddress(ctx, s.DB, val); err == nil {
				f.conds = append(f.conds, "m.sender_id = "+arg(id))
			} else {
				// A name: anyone whose name contains it.
				f.conds = append(f.conds, "m.sender_id IN (SELECT id FROM users WHERE display_name ILIKE '%' || "+
					arg(likeEscape.Replace(val))+" || '%')")
			}
		case "to":
			if lv == "me" {
				f.conds = append(f.conds, "EXISTS (SELECT 1 FROM message_recipients r WHERE r.message_id = m.id AND r.user_id = $1)")
			} else if strings.Contains(lv, "@") && !s.ourDomain(lv) {
				f.conds = append(f.conds, "EXISTS (SELECT 1 FROM message_recipients r JOIN users u ON u.id = r.user_id WHERE r.message_id = m.id AND u.external_address = "+arg(lv)+")")
			} else if id, err := s.resolveAddress(ctx, s.DB, val); err == nil {
				f.conds = append(f.conds, "EXISTS (SELECT 1 FROM message_recipients r WHERE r.message_id = m.id AND r.user_id = "+arg(id)+")")
			} else {
				p := arg(likeEscape.Replace(val))
				f.conds = append(f.conds, `EXISTS (SELECT 1 FROM message_recipients r
					LEFT JOIN users u ON u.id = r.user_id LEFT JOIN conversations g ON g.id = r.group_id
					WHERE r.message_id = m.id AND (u.display_name ILIKE '%' || `+p+` || '%' OR g.name ILIKE '%' || `+p+` || '%'))`)
			}
		case "has":
			if !strings.HasPrefix(lv, "attachment") && lv != "file" && lv != "files" {
				bad = errBadRequest("has: can only be has:attachment.")
			}
			f.conds = append(f.conds, "m.has_attachments")
		case "before", "after":
			d, err := parseSearchDate(val)
			if err != nil {
				bad = err
				return " "
			}
			if op == "before" {
				f.conds = append(f.conds, "m.sent_at < "+arg(d))
			} else {
				f.conds = append(f.conds, "m.sent_at >= "+arg(d))
			}
		case "in":
			switch lv {
			case "inbox":
				folder = "mb.folder = 'inbox'"
			case "spam", "trash":
				folder = "mb.folder = '" + lv + "'"
			case "sent":
				folder = "mb.folder <> 'trash' AND mb.is_mine"
			case "archive", "archived":
				folder = `mb.folder = 'inbox' AND EXISTS (SELECT 1 FROM user_conversations uc
					WHERE uc.user_id = mb.user_id AND uc.conversation_id = mb.conversation_id AND uc.hidden)`
			case "anywhere", "all":
				folder = ""
			default:
				bad = errBadRequest("in: can be inbox, sent, archived, spam, trash or anywhere.")
			}
		case "is":
			switch lv {
			case "unread":
				f.conds = append(f.conds, "NOT mb.is_read")
			case "read":
				f.conds = append(f.conds, "mb.is_read")
			case "starred", "favourite", "favorite":
				f.conds = append(f.conds, "mb.is_favourite")
			default:
				bad = errBadRequest("is: can be unread, read or starred.")
			}
		}
		return " "
	})
	if bad != nil {
		return f, bad
	}
	if folder != "" {
		f.conds = append(f.conds, folder)
	}
	f.text = strings.Join(strings.Fields(f.text), " ")
	return f, nil
}

func parseSearchDate(v string) (time.Time, error) {
	for _, layout := range []string{"2006-01-02", "2006/01/02", "2006-1-2", "2006/1/2"} {
		if t, err := time.ParseInLocation(layout, v, searchZone); err == nil {
			return t, nil
		}
	}
	return time.Time{}, errBadRequest("Dates look like 2026-09-30.")
}
