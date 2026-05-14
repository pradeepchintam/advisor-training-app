"""
Persona generation service.

Given partial parameters chosen by the advisor, fills in the remaining
details (name, occupation, income ranges, backstory) to create a
fully-realised ClientPersona.
"""
import random

from app.schemas import ClientPersona

# ---------------------------------------------------------------------------
# Name banks
# ---------------------------------------------------------------------------

MALE_FIRST_NAMES = [
    # Anglo / European
    "James", "William", "Robert", "Michael", "David", "Richard", "Joseph",
    "Thomas", "Charles", "Christopher", "Daniel", "Matthew", "Anthony",
    "Steven", "Paul", "Andrew", "Joshua", "Kevin", "Benjamin",
    "Alexander", "Patrick", "Jack", "Tyler", "Aaron", "Ethan",
    # Hispanic / Latino
    "Carlos", "Miguel", "Jose", "Luis", "Diego", "Alejandro", "Javier",
    "Ricardo", "Fernando", "Eduardo", "Andres", "Rafael",
    # African American
    "Marcus", "Andre", "Isaiah", "Darius", "Malik", "Elijah", "Nathaniel",
    "Terrence", "Jamal", "DeAndre", "Deon", "Rasheed",
    # South Asian
    "Raj", "Vikram", "Arjun", "Sanjay", "Nikhil", "Rahul",
    "Arun", "Amit", "Kiran", "Rohan", "Suresh", "Pradeep",
    # East / Southeast Asian
    "Wei", "Ming", "Jin", "Hiro", "Kenji", "Tae", "Jun",
    "Bao", "Thanh", "Duy", "Zheng", "Ryu",
    # Middle Eastern
    "Ahmed", "Omar", "Hassan", "Ali", "Khalid", "Tariq", "Yusuf", "Bilal",
]

FEMALE_FIRST_NAMES = [
    # Anglo / European
    "Mary", "Patricia", "Jennifer", "Linda", "Barbara", "Elizabeth",
    "Susan", "Jessica", "Sarah", "Karen", "Lisa", "Ashley", "Emily",
    "Stephanie", "Rebecca", "Laura", "Amy", "Angela", "Anna", "Emma",
    "Nicole", "Samantha", "Katherine", "Rachel", "Heather",
    # Hispanic / Latina
    "Maria", "Sofia", "Isabella", "Valentina", "Gabriela", "Lucia",
    "Adriana", "Carmen", "Rosa", "Elena", "Camila", "Daniela",
    # African American
    "Keisha", "Aaliyah", "Destiny", "Brianna", "Jasmine", "Monique",
    "Tiffany", "Imani", "Ebony", "Shaniqua", "Latoya", "Tamara",
    # South Asian
    "Priya", "Ananya", "Divya", "Sunita", "Pooja", "Rekha",
    "Meena", "Nisha", "Kavitha", "Deepa", "Lakshmi", "Rupa",
    # East / Southeast Asian
    "Mei", "Yuki", "Hana", "Lin", "Xiu", "Ji",
    "Linh", "Jade", "Ting", "Sakura", "Yuna", "Bao",
    # Middle Eastern
    "Fatima", "Aisha", "Nadia", "Layla", "Yasmin", "Rania", "Zara", "Sana",
]

LAST_NAMES = [
    # Anglo / European
    "Smith", "Johnson", "Williams", "Brown", "Jones", "Miller", "Davis",
    "Wilson", "Anderson", "Thomas", "Taylor", "Moore", "Jackson", "Martin",
    "White", "Harris", "Clark", "Lewis", "Robinson", "Walker", "Young",
    "King", "Wright", "Scott", "Green", "Adams", "Baker", "Nelson",
    "Carter", "Mitchell", "Campbell", "Hall",
    # Hispanic
    "Garcia", "Rodriguez", "Martinez", "Hernandez", "Lopez", "Gonzalez",
    "Perez", "Sanchez", "Ramirez", "Torres", "Flores", "Rivera",
    "Reyes", "Cruz", "Morales",
    # Asian
    "Lee", "Nguyen", "Chen", "Kim", "Patel", "Singh", "Wang", "Liu",
    "Zhang", "Kumar", "Sharma", "Gupta", "Yamamoto", "Tanaka", "Park",
    "Nakamura", "Tran", "Vo", "Zhou", "Wu",
    # African / African American
    "Okafor", "Nwosu", "Mensah", "Diallo", "Washington", "Jefferson",
    "Freeman", "Booker", "Bryant", "Jordan", "Adeyemi", "Okoro",
    # Middle Eastern / South Asian Muslim
    "Ali", "Hassan", "Ahmed", "Khan", "Rahman", "Sheikh", "Malik",
]

# ---------------------------------------------------------------------------
# Occupation maps
# ---------------------------------------------------------------------------

OCCUPATION_MAP: dict[str, list[str]] = {
    "employed": [
        "Software Engineer", "Registered Nurse", "Accountant", "Marketing Manager",
        "Sales Representative", "Human Resources Manager", "Project Manager",
        "Electrical Engineer", "Physical Therapist", "Teacher",
    ],
    "self_employed": [
        "Independent Consultant", "Freelance Designer", "Realtor",
        "Independent Contractor", "Personal Trainer", "Photographer",
        "Copywriter", "Web Developer",
    ],
    "business_owner": [
        "Restaurant Owner", "Retail Store Owner", "Manufacturing Business Owner",
        "IT Services Company Owner", "Landscaping Business Owner",
        "Dental Practice Owner", "Law Firm Partner",
    ],
    "executive": [
        "Chief Executive Officer", "Chief Financial Officer", "Vice President of Operations",
        "Senior Vice President", "Chief Technology Officer", "Managing Director",
        "Regional Director",
    ],
    "retired": [
        "Retired Teacher", "Retired Engineer", "Retired Military Officer",
        "Retired Nurse", "Retired Executive", "Retired Government Employee",
    ],
    "part_time": [
        "Part-time Retail Associate", "Part-time Administrative Assistant",
        "Part-time Tutor", "Freelancer",
    ],
    "unemployed": [
        "Currently Seeking Employment", "Career Transition",
    ],
}

# ---------------------------------------------------------------------------
# Financial ranges
# ---------------------------------------------------------------------------

FINANCIAL_RANGES: dict[str, dict[str, str]] = {
    "struggling": {
        "net_worth": "Under $50K",
        "income": "$25K - $45K / year",
    },
    "stable": {
        "net_worth": "$50K - $250K",
        "income": "$45K - $80K / year",
    },
    "comfortable": {
        "net_worth": "$250K - $750K",
        "income": "$80K - $150K / year",
    },
    "affluent": {
        "net_worth": "$750K - $2M",
        "income": "$150K - $350K / year",
    },
    "wealthy": {
        "net_worth": "$2M - $10M",
        "income": "$350K - $1M / year",
    },
    "ultra_wealthy": {
        "net_worth": "$10M+",
        "income": "$1M+ / year",
    },
}

# ---------------------------------------------------------------------------
# Age group helper
# ---------------------------------------------------------------------------

def _age_group(age: int) -> str:
    if age <= 35:
        return "young_adult"
    if age <= 55:
        return "middle_aged"
    if age <= 70:
        return "senior"
    return "elderly"


# ---------------------------------------------------------------------------
# Backstory templates
# ---------------------------------------------------------------------------

def _generate_backstory(params: dict) -> str:
    name = params.get("name", "The client")
    age = params.get("age", 45)
    occupation = params.get("occupation", "professional")
    marital = params.get("marital_status", "married")
    has_children = params.get("has_children", False)
    num_children = params.get("num_children", 0)
    concerns = params.get("primary_concerns") or [params.get("primary_concern", "retirement")]
    concern = concerns[0] if concerns else "retirement"
    financial = params.get("financial_situation", "comfortable")
    previous = params.get("previous_advisor", False)
    prev_exp = params.get("previous_advisor_experience", "none")

    # Build children clause
    children_clause = ""
    if has_children and num_children > 0:
        children_clause = f" with {num_children} {'child' if num_children == 1 else 'children'}"

    # Build previous advisor clause
    advisor_clause = ""
    if previous and prev_exp != "none":
        if prev_exp == "positive":
            advisor_clause = " They had a positive relationship with a previous advisor but are looking for better service."
        elif prev_exp == "negative":
            advisor_clause = " A previous advisor relationship left them cautious and skeptical."
        elif prev_exp == "neutral":
            advisor_clause = " They worked with an advisor before but felt the relationship was impersonal."
    else:
        advisor_clause = " They have never worked with a financial advisor before."

    # Concern mapping
    concern_map = {
        "retirement": "secure their retirement",
        "wealth_growth": "grow their wealth",
        "estate_planning": "plan their estate",
        "tax_optimization": "reduce their tax burden",
        "college_funding": "fund their children's education",
        "income_generation": "generate reliable income",
        "debt_reduction": "get out of debt",
        "insurance": "protect against unexpected risks",
        "business_succession": "plan their business succession",
        "charitable_giving": "structure their charitable giving",
    }
    goal = concern_map.get(concern, "manage their finances better")

    backstory = (
        f"{name} is a {age}-year-old {marital} {occupation}{children_clause}. "
        f"They are seeking advice to help {goal}."
        f"{advisor_clause}"
    )
    return backstory


# ---------------------------------------------------------------------------
# Main function
# ---------------------------------------------------------------------------

def generate_persona_details(params: dict) -> ClientPersona:
    """
    Fill in any missing fields in a partial persona params dict and return
    a fully populated ClientPersona.
    """
    # Resolve gender
    gender = params.get("gender") or random.choice(["male", "female"])
    params["gender"] = gender

    # Resolve name
    if not params.get("name"):
        first = random.choice(MALE_FIRST_NAMES if gender == "male" else FEMALE_FIRST_NAMES)
        last = random.choice(LAST_NAMES)
        params["name"] = f"{first} {last}"

    # Resolve age group
    age = params.get("age") or random.randint(30, 65)
    params["age"] = age
    params["age_group"] = _age_group(age)

    # Resolve employment — accept either list (new) or single string (legacy)
    employment_types = params.get("employment_types") or []
    if not employment_types and params.get("employment_type"):
        employment_types = [params["employment_type"]]
    if not employment_types:
        employment_types = ["employed"]
    params["employment_types"] = employment_types
    primary_employment = employment_types[0]
    if not params.get("occupation"):
        options = OCCUPATION_MAP.get(primary_employment, OCCUPATION_MAP["employed"])
        params["occupation"] = random.choice(options)

    # Resolve financial ranges
    financial_situation = params.get("financial_situation") or "comfortable"
    params["financial_situation"] = financial_situation
    ranges = FINANCIAL_RANGES.get(financial_situation, FINANCIAL_RANGES["comfortable"])
    if not params.get("estimated_net_worth"):
        params["estimated_net_worth"] = ranges["net_worth"]
    if not params.get("estimated_income"):
        params["estimated_income"] = ranges["income"]

    # Default children
    if "has_children" not in params:
        params["has_children"] = random.choice([True, False])
    if not params.get("num_children"):
        params["num_children"] = random.randint(1, 3) if params["has_children"] else 0

    # Default marital status
    if not params.get("marital_status"):
        params["marital_status"] = random.choice(["married", "single", "divorced"])

    # Default risk tolerance
    if not params.get("risk_tolerance"):
        params["risk_tolerance"] = "moderate"

    # Default investment experience
    if not params.get("investment_experience"):
        params["investment_experience"] = "beginner"

    # Resolve concerns — accept either list (new) or single string (legacy)
    primary_concerns = params.get("primary_concerns") or []
    if not primary_concerns and params.get("primary_concern"):
        primary_concerns = [params["primary_concern"]]
    if not primary_concerns:
        primary_concerns = ["retirement"]
    params["primary_concerns"] = primary_concerns

    # Default personality
    if not params.get("personality_type"):
        params["personality_type"] = random.choice(
            ["anxious", "confident", "skeptical", "analytical", "emotional"]
        )

    # Default communication style
    if not params.get("communication_style"):
        params["communication_style"] = random.choice(["direct", "chatty", "reserved"])

    # Default debt
    if not params.get("has_debt"):
        params["has_debt"] = "manageable"

    # Default previous advisor
    if "previous_advisor" not in params:
        params["previous_advisor"] = random.choice([True, False])
    if not params.get("previous_advisor_experience"):
        params["previous_advisor_experience"] = "none" if not params["previous_advisor"] else "neutral"

    # Default urgency
    if not params.get("urgency"):
        params["urgency"] = "medium"

    # Default referral source
    if not params.get("referral_source"):
        params["referral_source"] = random.choice(["friend", "internet", "existing_client"])

    # Generate backstory
    if not params.get("backstory"):
        params["backstory"] = _generate_backstory(params)

    return ClientPersona(**params)


# ---------------------------------------------------------------------------
# Persona options for frontend dropdowns
# ---------------------------------------------------------------------------

PERSONA_OPTIONS: dict[str, list[str]] = {
    "age_group": ["young_adult", "middle_aged", "senior", "elderly"],
    "gender": ["male", "female"],
    "marital_status": ["single", "married", "divorced", "widowed", "domestic_partner"],
    "employment_type": [
        "employed", "self_employed", "business_owner", "executive",
        "retired", "part_time", "unemployed",
    ],
    "financial_situation": [
        "struggling", "stable", "comfortable", "affluent", "wealthy", "ultra_wealthy"
    ],
    "has_debt": ["none", "manageable", "significant", "overwhelming"],
    "risk_tolerance": [
        "very_conservative", "conservative", "moderate", "aggressive", "very_aggressive"
    ],
    "investment_experience": ["none", "beginner", "intermediate", "experienced", "expert"],
    "primary_concern": [
        "retirement", "wealth_growth", "estate_planning", "tax_optimization",
        "college_funding", "income_generation", "debt_reduction", "insurance",
        "business_succession", "charitable_giving",
    ],
    "personality_type": [
        "anxious", "confident", "skeptical", "analytical", "emotional",
        "impulsive", "detail_oriented", "trusting",
    ],
    "communication_style": ["direct", "reserved", "chatty", "formal"],
    "previous_advisor_experience": ["positive", "negative", "neutral", "none"],
    "urgency": ["low", "medium", "high"],
    "referral_source": [
        "friend", "internet", "cold_call", "existing_client", "employer", "other"
    ],
}
