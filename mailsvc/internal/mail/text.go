package mail

import (
	"html"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/microcosm-cc/bluemonday"
)

var (
	tagRe   = regexp.MustCompile(`(?s)<(script|style)[^>]*>.*?</(script|style)>|<[^>]+>`)
	spaceRe = regexp.MustCompile(`\s+`)
)

// stripTags turns HTML into rough plain text, for snippets.
func stripTags(s string) string {
	if s == "" {
		return ""
	}
	s = tagRe.ReplaceAllString(s, " ")
	return strings.TrimSpace(spaceRe.ReplaceAllString(html.UnescapeString(s), " "))
}

// htmlPolicy keeps what email formatting needs (text styles, lists, tables, links,
// images) and drops everything that can run code or restyle the app: <script>,
// <style>, <iframe>, <form>, event attributes like onclick, javascript: links and
// inline style. Links get rel="nofollow noopener" and open in a new tab.
var htmlPolicy = func() *bluemonday.Policy {
	p := bluemonday.UGCPolicy()
	p.RequireNoFollowOnLinks(true)
	p.AddTargetBlankToFullyQualifiedLinks(true)
	return p
}()

// cleanContent checks the sizes of what a person wrote and makes body_html safe to
// display. It runs before anything is stored, so no client can ever receive HTML
// that runs scripts, whichever way it renders it.
func cleanContent(subject, bodyText, bodyHTML *string) error {
	*subject = strings.TrimSpace(strings.Join(strings.Fields(*subject), " ")) // one line
	if utf8.RuneCountInString(*subject) > MaxSubjectChars {
		return errBadRequest("The subject can be at most %d characters.", MaxSubjectChars)
	}
	if len(*bodyText) > MaxBodyText {
		return errBadRequest("The message is too long (at most %d KB of text).", MaxBodyText>>10)
	}
	if len(*bodyHTML) > MaxBodyHTML {
		return errBadRequest("The message is too long (at most %d KB of formatted text).", MaxBodyHTML>>10)
	}
	if *bodyHTML != "" {
		*bodyHTML = strings.TrimSpace(htmlPolicy.Sanitize(*bodyHTML))
	}
	return nil
}
