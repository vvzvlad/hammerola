import pytest
from pydantic import ValidationError

from ci.smoke import REQUIRED_VARIABLES
from src.settings import Settings, build_environment


def test_the_gate_knows_every_credential_this_declares():
    """`ci/smoke.py` asks the image's guard to name each variable BY NAME, off a
    list it keeps by hand — and its own comment says to keep that list in step
    with the no-default fields here. This is that instruction, mechanised.

    A credential added to Settings without a line in REQUIRED_VARIABLES is a key
    the gate never proves the guard names, and nothing else fails: the gate goes
    on casting the verdicts it knows about and passes. The check runs in the
    suite rather than in the gate because it is a comparison between two source
    files, which is precisely what the gate — running against a built artefact —
    cannot make.
    """
    no_default = sorted(name.upper() for name, field
                        in Settings.model_fields.items()
                        if field.is_required())
    assert no_default == sorted(REQUIRED_VARIABLES)


def test_loads_from_env(monkeypatch):
    monkeypatch.setenv("EDIT_TOKEN", "s3cret")
    monkeypatch.setenv("LOG_LEVEL", "DEBUG")
    s = Settings(_env_file=None)
    assert s.edit_token == "s3cret"
    assert s.log_level == "DEBUG"


def test_defaults_match_the_spec(monkeypatch):
    # SPEC 7.5 fixes every default, and the deployment relies on them: only
    # EDIT_TOKEN and the optional KICAD_URL are set in docker-compose.yml, so a
    # drift here silently changes how the deployment behaves.
    monkeypatch.setenv("EDIT_TOKEN", "s3cret")
    for name in ("HOST", "PORT", "DATA_DIR", "LOG_LEVEL"):
        monkeypatch.delenv(name, raising=False)
    s = Settings(_env_file=None)
    assert s.host == "0.0.0.0"
    assert s.port == 8000
    assert s.data_dir == "data"
    assert s.log_level == "INFO"


@pytest.mark.parametrize("value", [None, ""])
def test_without_kicad_url_the_hub_loads_with_no_kicad_service(monkeypatch,
                                                               value):
    monkeypatch.setenv("EDIT_TOKEN", "s3cret")
    if value is None:
        monkeypatch.delenv("KICAD_URL", raising=False)
    else:
        monkeypatch.setenv("KICAD_URL", value)
    assert Settings(_env_file=None).kicad_url is None


def test_there_is_no_retention_setting(monkeypatch):
    """The absence is the feature (SPEC 5.3, 7.3), so it is asserted.

    Nothing published is ever deleted, so there is no window to configure — and
    a field reappearing here is how retention would come back by accident. The
    environment variable is set to prove the point from the other side: even
    spelled out in the environment, it is `extra="ignore"` and nothing reads it.
    """
    monkeypatch.setenv("EDIT_TOKEN", "s3cret")
    monkeypatch.setenv("RETENTION_BUILDS", "3")
    s = Settings(_env_file=None)
    assert not hasattr(s, "retention_builds")
    assert not [name for name in type(s).model_fields
                if "retention" in name or "keep" in name]


def test_missing_credential_fails(monkeypatch):
    # A missing credential must blow up at construction time, not silently default.
    monkeypatch.delenv("EDIT_TOKEN", raising=False)
    with pytest.raises(ValidationError):
        Settings(_env_file=None)


def test_empty_credential_fails(monkeypatch):
    # An empty EDIT_TOKEN is worse than a missing one: it would start the
    # service and then accept an empty `X-Hammerola-Token` from anybody, so it
    # has to be refused at exactly the same place.
    monkeypatch.setenv("EDIT_TOKEN", "")
    with pytest.raises(ValidationError):
        Settings(_env_file=None)


def test_hub_branding_is_off_by_default(monkeypatch):
    monkeypatch.setenv("EDIT_TOKEN", "s3cret")
    for name in ("HUB_NAME", "HUB_LOGO"):
        monkeypatch.delenv(name, raising=False)
    s = Settings(_env_file=None)
    assert (s.hub_name, s.hub_logo) == (None, None)


@pytest.mark.parametrize("name, kept", [("", None), ("  ", None), (" Acme ", "Acme")])
def test_hub_name_is_stripped_and_blank_means_none(monkeypatch, name, kept):
    monkeypatch.setenv("EDIT_TOKEN", "s3cret")
    monkeypatch.setenv("HUB_NAME", name)
    assert Settings(_env_file=None).hub_name == kept


def test_hub_logo_is_an_existing_image_file(monkeypatch, tmp_path):
    monkeypatch.setenv("EDIT_TOKEN", "s3cret")
    logo = tmp_path / "mark.PNG"
    logo.write_bytes(b"x")
    monkeypatch.setenv("HUB_LOGO", str(logo))
    assert Settings(_env_file=None).hub_logo == str(logo)
    monkeypatch.setenv("HUB_LOGO", "")
    assert Settings(_env_file=None).hub_logo is None


def test_hub_logo_naming_no_file_is_refused_with_its_path(monkeypatch, tmp_path):
    monkeypatch.setenv("EDIT_TOKEN", "s3cret")
    missing = tmp_path / "gone.png"
    monkeypatch.setenv("HUB_LOGO", str(missing))
    with pytest.raises(ValidationError, match="gone.png"):
        Settings(_env_file=None)


def test_hub_logo_of_a_wrong_suffix_is_refused_with_its_path(monkeypatch, tmp_path):
    monkeypatch.setenv("EDIT_TOKEN", "s3cret")
    notes = tmp_path / "notes.txt"
    notes.write_bytes(b"x")
    monkeypatch.setenv("HUB_LOGO", str(notes))
    with pytest.raises(ValidationError, match="notes.txt"):
        Settings(_env_file=None)


def test_build_environment_is_the_prefixed_variables_under_their_own_names():
    environ = {"BUILD_ENV_UPLOAD_KEY": "k", "BUILD_ENV_": "bare",
               "EDIT_TOKEN": "s3cret", "KICAD_URL": "http://kicad",
               "XBUILD_ENV_NOT": "x", "build_env_lower": "y"}

    assert build_environment(environ) == {"BUILD_ENV_UPLOAD_KEY": "k",
                                          "BUILD_ENV_": "bare"}


def test_build_environment_reads_the_process_environment_by_default(
        monkeypatch):
    monkeypatch.setenv("BUILD_ENV_FROM_THE_PROCESS", "yes")

    assert build_environment()["BUILD_ENV_FROM_THE_PROCESS"] == "yes"
