import dayjs from "dayjs";
import "dayjs/locale/ko.js";

/** "9월 15일 오후 11:33": when a conversation started, for one without a title yet. */
export const dayAndTime = (iso: string) => dayjs(iso).locale("ko").format("M월 D일 A hh:mm");

/** "오후 09:53": when something happened, where the day goes without saying. */
export const timeOfDay = (iso: string) => dayjs(iso).locale("ko").format("A hh:mm");
