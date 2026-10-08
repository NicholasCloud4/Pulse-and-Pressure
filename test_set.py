# Each entry: (note text, [list of readings])
# A reading is (systolic, diastolic, pulse), using None for anything missing.
# A note with no readings has an empty list: []
#
# All of these are made-up examples. Add your real notes in the same format.
#
# RECORD OF RESULTS (llama3.2:3b), for the writeup:
#   First multi-reading version, before any tuning on the second batch:
#     development 31/35, unseen holdout 16/20 (the first honest number)
#   After that, the 20 holdout notes were moved into TESTS below, because we
#   looked at their misses. HOLDOUT is a brand new set of 20 unseen notes.

# ---------------------------------------------------------------------------
# TESTS: the "development" set. The prompt was tuned while looking at these.
# ---------------------------------------------------------------------------
TESTS = [
    # --- Clean-ish notes ---
    ("bp high today 140 over 90, pulse 78", [(140, 90, 78)]),
    ("128/82 p71", [(128, 82, 71)]),
    ("morning: 122/80", [(122, 80, None)]),
    ("felt dizzy, 135/85", [(135, 85, None)]),
    ("BP 118/76 HR 64", [(118, 76, 64)]),
    ("evening 131/84 pulse 80", [(131, 84, 80)]),
    ("120/80", [(120, 80, None)]),
    ("after coffee 138/88 p 85", [(138, 88, 85)]),
    ("woke up, 115/72, pulse 60", [(115, 72, 60)]),
    ("124 over 79 hr 68", [(124, 79, 68)]),
    ("bp: 142/91 pulse: 90", [(142, 91, 90)]),
    ("pm 126/81 p74", [(126, 81, 74)]),
    ("after walk 119/74 pulse 88", [(119, 74, 88)]),
    ("stressed at work!! 145/93 p 92", [(145, 93, 92)]),
    ("sys 129 dia 83 pulse 70", [(129, 83, 70)]),

    # --- Dates and times mixed in ---
    ("10/2 126/84", [(126, 84, None)]),
    ("Oct 3: 118/76 pulse 64", [(118, 76, 64)]),
    ("9/28 7am 132/86 p77", [(132, 86, 77)]),
    ("Tuesday 8:30pm 121/78 pulse 69", [(121, 78, 69)]),
    ("2026-10-01 135/85 hr 72", [(135, 85, 72)]),

    # --- Typos and odd wording ---
    ("blood presure 130 ovr 85", [(130, 85, None)]),
    ("bp 127 / 80 , puls 66", [(127, 80, 66)]),
    ("pressure was 133 over 87 and heart rate 81", [(133, 87, 81)]),
    ("one thirty over eighty five", [(130, 85, None)]),
    ("BP 122/ 78 pulse- 71", [(122, 78, 71)]),

    # --- Missing or partial info (should NOT be guessed) ---
    ("pulse 80", [(None, None, 80)]),
    ("forgot to check today", []),
    ("cuff said error, will retry later", []),
    ("took my meds this morning", []),
    ("feeling headachy, bp 150/95", [(150, 95, None)]),

    # --- Several readings in one note ---
    ("122/80 am, 135/85 pm", [(122, 80, None), (135, 85, None)]),
    ("am 119/77 p63 pm 128/83 p74", [(119, 77, 63), (128, 83, 74)]),
    ("first 141/92 then 136/88", [(141, 92, None), (136, 88, None)]),
    ("10/3 morning 117/75, evening 125/81 pulse 70",
     [(117, 75, None), (125, 81, 70)]),
    ("120/80 p66, 124/82 p71, 118/78 p64", [(120, 80, 66), (124, 82, 71), (118, 78, 64)]),

    # --- Moved in from the first holdout (we have now seen their misses) ---
    ("morning 118/76 p62, night 129/82 p75", [(118, 76, 62), (129, 82, 75)]),
    ("left arm 130/85, right arm 126/82", [(130, 85, None), (126, 82, None)]),
    ("sitting 121/79 p68 standing 115/74 p76", [(121, 79, 68), (115, 74, 76)]),
    ("BP 119 over 77. Pulse 61. Later: 127 over 83, pulse 72",
     [(119, 77, 61), (127, 83, 72)]),
    ("1st 142/90 2nd 138/88 3rd 134/85", [(142, 90, None), (138, 88, None), (134, 85, None)]),
    ("took 2 pills then checked: 133/86", [(133, 86, None)]),
    ("weight 165 lbs, bp 124/80, pulse 70", [(124, 80, 70)]),
    ("temp 98.6 bp 117/75 hr 66", [(117, 75, 66)]),
    ("slept 6 hrs, bp 125/81, p 69", [(125, 81, 69)]),
    ("took meds at 8, bp 126/82 at 10", [(126, 82, None)]),
    ("doctor said aim for under 130/80", []),
    ("Sunday 10/4 - 128/84 - 73 bpm", [(128, 84, 73)]),
    ("SYS/DIA 137/89 PUL 83", [(137, 89, 83)]),
    ("one twenty over eighty", [(120, 80, None)]),
    ("9am: 120/78 (p 65)", [(120, 78, 65)]),
    ("dizzy when standing up, pulse 102, bp 110/70", [(110, 70, 102)]),
    ("ate salty food, bp up 148/94", [(148, 94, None)]),
    ("pulse 95 after stairs", [(None, None, 95)]),
    ("no reading, cuff batteries dead", []),
]

# ---------------------------------------------------------------------------
# HOLDOUT: 20 fresh notes, written without looking at the model's behavior
# on them. Run once for an honest score. If you change the prompt because of
# a miss here, replace these with new notes before reporting a number.
# ---------------------------------------------------------------------------
HOLDOUT = [
    # Single readings in different styles
    ("bp 126/84 p 72 before breakfast", [(126, 84, 72)]),
    ("hr 64 then bp 119/75", [(119, 75, 64)]),
    ("BP 135/88 (HR 79) feeling tired", [(135, 88, 79)]),
    ("systolic 139 diastolic 91 heart rate 84", [(139, 91, 84)]),
    ("127/82, 69 bpm", [(127, 82, 69)]),
    ("stood up fast, got dizzy. 108/68 pulse 98", [(108, 68, 98)]),

    # Dates and times
    ("10/6 6:45am 117/73 pulse 59", [(117, 73, 59)]),
    ("Mon 118/76, Tue 124/79, Wed 131/85", [(118, 76, None), (124, 79, None), (131, 85, None)]),

    # Several readings
    ("morning 121/77 p64, afternoon 130/85 p73, bedtime 116/74 p61",
     [(121, 77, 64), (130, 85, 73), (116, 74, 61)]),
    ("128/84 then rechecked 124/80 five min later", [(128, 84, None), (124, 80, None)]),
    ("took bp twice, 131/86 and 129/84", [(131, 86, None), (129, 84, None)]),
    ("AM 120/79 p68, PM 126/82", [(120, 79, 68), (126, 82, None)]),

    # Extra numbers that are not readings
    ("ran 3 miles, pulse 140 right after, bp 150/88", [(150, 88, 140)]),
    ("1 hour after meds: 122/78", [(122, 78, None)]),
    ("lost 2 lbs this week! bp 114/72 pulse 63", [(114, 72, 63)]),
    ("bp goal is 120/80, mine today 129/83", [(129, 83, None)]),

    # Spoken-style numbers
    ("one fifty over ninety five", [(150, 95, None)]),

    # Partial or empty
    ("pulse 77", [(None, None, 77)]),
    ("cuff wouldn't work, no number", []),
    ("bp was fine today", []),
]