// Derived from dolotech/doudizhu, Apache-2.0. See NOTICE.md.
package algorithm

// GetValue decodes the original upstream byte encoding. Dealing, shuffling,
// and card ownership validation are deliberately implemented by the game layer.
func GetValue(card byte) byte {
	if card == 0xEF {
		return XIAO_WANG
	}
	if card == 0xFF {
		return DA_WANG
	}
	if card&0xF == 2 {
		return TWO
	}
	return card & 0xF
}
