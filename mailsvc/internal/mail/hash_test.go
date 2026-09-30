package mail

import "testing"

func TestParticipantHashIgnoresOrderAndDuplicates(t *testing.T) {
	a := ParticipantHash([]int64{3, 1, 2})
	if b := ParticipantHash([]int64{2, 3, 1, 1}); a != b {
		t.Fatalf("same set, different hash: %s vs %s", a, b)
	}
	if c := ParticipantHash([]int64{1, 2}); c == a {
		t.Fatal("different sets gave the same hash")
	}
}

func TestReplySubject(t *testing.T) {
	cases := map[string]string{"Hello": "Re: Hello", "Re: Hello": "Re: Hello", "RE: re: x": "Re: x", "": "Re:"}
	for in, want := range cases {
		if got := replySubject(in); got != want {
			t.Errorf("replySubject(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestIDLabelSortsNumerically(t *testing.T) {
	if !(idLabel(9) < idLabel(10)) {
		t.Fatal("path labels must sort in numeric order")
	}
}
