import uuid

from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class UserOut(BaseModel):
    id: uuid.UUID
    username: str
    isAdmin: bool
    mustChangePassword: bool
    features: list[str] = Field(default_factory=list)


class LoginResponse(BaseModel):
    token: str
    user: UserOut


class ChangePasswordRequest(BaseModel):
    currentPassword: str = Field(min_length=1, max_length=256)
    newPassword: str = Field(min_length=8, max_length=256)
